/**
 * hnradio on Cloudflare: one Worker serves the built SPA (ASSETS binding),
 * the /api/* surface, and /e/:hnId episode landing pages with server-rewritten
 * OG tags. Generation runs as a durable Workflow (see pipeline.mjs); the daily
 * 7pm America/Chicago sweep fires from an hourly cron trigger (DST-proof).
 */
import { listDramas, getDrama, findByHnIdAndMode, upsertDrama, deleteOtherEpisodesOfThread, getSetting, isDroppedEpisode } from './store.mjs'
import { deathThreadMatch } from './death-thread.mjs'
import { pseudonymOptions } from './pseudonyms.mjs'
import {
  buildSourceMetadata,
  fetchThread,
  hydrateThreadArticle,
  threadToTranscript,
  verifiedSourceProgress,
} from './hn.mjs'
import { spotifyCallback, spotifyStart, spotifyStatus } from './spotify.mjs'
import { operatorAuthorization } from './operator-auth.mjs'
import { operatorNightlyReconcile } from './operator-nightly.mjs'
import { runNightlyReconciliation } from './nightly.mjs'
import { approvalFailure, readShowReadiness } from './readiness.mjs'
import {
  getActiveWorkflowDeployGate,
  workflowDeployRetryAfterSeconds,
} from './deploy-gate.mjs'
import {
  claimCommunityGeneration,
  communityConfig,
  communityStatus,
  confirmCommunityFollow,
  releaseCommunityGeneration,
} from './community-access.mjs'

export { HnrPipeline } from './pipeline.mjs'

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  // Media (episode MP3s) streams from files.sleeperhitlist.com; PostHog needs
  // event ingestion (us.i) + lazy-loaded modules (us-assets.i); everything
  // else is same-origin. Vite emits plain script/style tags (no inline JS).
  // Keep in sync with web/public/_headers (covers ASSETS-served paths).
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; media-src 'self' https://files.sleeperhitlist.com; " +
    "style-src 'self' 'unsafe-inline'; " +
    "script-src 'self' https://us-assets.i.posthog.com https://challenges.cloudflare.com; " +
    "connect-src 'self' https://us.i.posthog.com https://us-assets.i.posthog.com https://challenges.cloudflare.com; " +
    "frame-src https://challenges.cloudflare.com; frame-ancestors 'none'",
}

function withHeaders(res, extra = {}) {
  const out = new Response(res.body, res)
  for (const [k, v] of Object.entries({ ...SECURITY_HEADERS, ...extra })) out.headers.set(k, v)
  return out
}

const json = (data, status = 200, headers = {}) =>
  withHeaders(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } }))

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

async function workflowDeployGateResponse(env) {
  const now = new Date()
  const gate = await getActiveWorkflowDeployGate(env.DB, { now })
  if (!gate) return null
  const retryAfter = workflowDeployRetryAfterSeconds(gate, now)
  return json({
    error: 'Workflow starts are briefly paused while the Worker deploy stabilizes.',
    code: 'workflow_deploying',
    retryAfterSeconds: retryAfter,
  }, 503, { 'Retry-After': String(retryAfter) })
}

/**
 * A visitor's episode spends exactly what a nightly one does, so it passes the
 * same READINESS PREFLIGHT first: the project's workspace gate and table-read
 * readiness, a balance that covers an episode, and the publishing series'
 * standing approval for HNR's key. Returns null when an episode may start, or
 * the refusal to send the visitor (the reason class, not the internals).
 */
export async function communityGenerationRefusal(env, { readReadiness = readShowReadiness } = {}) {
  let readiness
  try {
    readiness = await readReadiness(env, { seriesId: await getSetting(env.DB, 'publishingSeriesId') })
  } catch {
    readiness = { checked: false }
  }
  if (!readiness?.checked) {
    return {
      status: 503,
      code: 'show_readiness_unavailable',
      error: 'HN Radio could not confirm it can take a new episode right now. Try again in a few minutes.',
    }
  }
  const failure = readiness.ready ? approvalFailure(readiness.publishing) : readiness
  if (!failure) return null
  return {
    status: 503,
    code: 'show_not_ready',
    reason: failure.failureClass,
    error: 'HN Radio is not taking new episodes right now. Existing episodes are still playable.',
  }
}

/** A visitor's thread the show will not make. Same refusal whether the title or the article gave it away. */
function notCoveredError(code) {
  const err = new Error(code === 'episode_dropped'
    ? 'HN Radio does not make an episode of this thread.'
    : 'HN Radio does not cover threads about someone\'s death.')
  err.code = code
  err.status = 422
  return err
}

export async function startGeneration(request, env, url, {
  force = false,
  requireEntitlement = true,
  deps = {},
} = {}) {
  const {
    fetchThread: readThread = fetchThread,
    readReadiness = readShowReadiness,
    hydrateArticle = hydrateThreadArticle,
  } = deps
  const thread = await readThread(url, pseudonymOptions(env))
  // Owner rule (2026-10-04): the show never covers a thread about a real person's death, nightly or requested.
  if (deathThreadMatch({ title: thread.title, storyText: thread.storyText })) throw notCoveredError('death_thread')
  const existing = await findByHnIdAndMode(env.DB, thread.id, 'podcast')
  // A dropped episode's thread is never made again, `force` or not.
  if (isDroppedEpisode(existing)) throw notCoveredError('episode_dropped')
  if (!force) {
    if (existing && ['queued', 'running', 'ready'].includes(existing.status)) return { drama: existing, reused: true }
  }
  // Nothing new is claimed, uploaded, planned or approved while the show
  // cannot start an episode — or has no standing approval to approve one.
  const refusal = await communityGenerationRefusal(env, { readReadiness })
  if (refusal) {
    const err = new Error(refusal.error)
    err.code = refusal.code
    err.status = refusal.status
    err.reason = refusal.reason ?? null
    throw err
  }
  await hydrateArticle(thread)
  if (deathThreadMatch({ articleTitle: thread.article?.title, articleText: thread.article?.text })) {
    throw notCoveredError('death_thread')
  }
  const sourceTranscript = threadToTranscript(thread)
  const sourceMetadata = buildSourceMetadata(thread, sourceTranscript)
  let entitlementClaimed = false
  if (requireEntitlement) {
    const claim = await claimCommunityGeneration(request, env, thread.id)
    if (!claim.ok) {
      const err = new Error(claim.code)
      err.code = claim.code
      err.generatedHnId = claim.generatedHnId || null
      throw err
    }
    entitlementClaimed = true
  }
  const drama = {
    id: crypto.randomUUID(),
    hnId: thread.id,
    mode: 'podcast',
    url: thread.url,
    title: thread.title,
    commentCount: thread.total,
    points: thread.points ?? null,
    status: 'queued',
    progress: [{
      at: new Date().toISOString(),
      message: verifiedSourceProgress(thread),
      runId: 'request-preflight',
      eventKey: 'source-completeness-verified',
    }],
    sourceCompleteness: sourceMetadata.sourceCompleteness,
    audioUrl: null,
    error: null,
    createdAt: new Date().toISOString(),
  }
  try {
    await upsertDrama(env.DB, drama)
    await env.PIPELINE.create({ id: drama.id, params: { dramaId: drama.id, url: thread.url } })
    // Only retire superseded cards after the replacement Workflow exists. If
    // queue creation fails, the old playable/diagnostic row remains intact.
    if (force) await deleteOtherEpisodesOfThread(env.DB, thread.id, 'podcast', drama.id).catch(() => {})
  } catch (err) {
    if (entitlementClaimed) await releaseCommunityGeneration(request, env, thread.id)
    throw err
  }
  return { drama, reused: false }
}

async function handleApi(request, env, url) {
  const { pathname } = url
  if (pathname === '/api/auth/spotify/start' && request.method === 'GET') return spotifyStart(request, env, url)
  if (pathname === '/api/auth/spotify/callback' && request.method === 'GET') return spotifyCallback(request, env, url)
  if (pathname === '/api/auth/spotify/status' && request.method === 'GET') return json(await spotifyStatus(request, env))
  if (pathname === '/api/community/config' && request.method === 'GET') {
    return json(communityConfig(env), 200, { 'Cache-Control': 'no-store' })
  }
  if (pathname === '/api/community/status' && request.method === 'GET') return json(await communityStatus(request, env))
  if (pathname === '/api/community/confirm-follow' && request.method === 'POST') {
    const result = await confirmCommunityFollow(request, env)
    if (!result.ok) return json({ error: result.code, code: result.code }, 403)
    return json({ confirmed: true, used: result.used, generatedHnId: result.generatedHnId }, 200, { 'Set-Cookie': result.cookie })
  }
  if (pathname === '/api/health') {
    return json({ ok: true, apiBase: env.SLEEPERHIT_API_BASE, hasKey: Boolean(env.SLEEPERHIT_API_KEY), platform: 'cloudflare' })
  }
  // Safe operational backstop for a missed/stalled hourly tick. It runs the
  // exact same idempotent reconciler as the cron and remains invisible unless
  // the existing operator credential has been configured.
  if (pathname === '/api/operator/nightly/reconcile' && request.method === 'POST') {
    const result = await operatorNightlyReconcile(request, env)
    return json(result.body, result.status, result.headers)
  }
  if (pathname === '/api/dramas' && request.method === 'GET') {
    const q = url.searchParams.get('q') ?? ''
    const includeFailed = url.searchParams.get('includeFailed') === 'true'
    return json({ dramas: await listDramas(env.DB, { q, includeFailed }) })
  }
  const one = pathname.match(/^\/api\/dramas\/([0-9a-f-]{36})$/)
  if (one && request.method === 'GET') {
    const drama = await getDrama(env.DB, one[1])
    // A dropped episode is not on the site.
    return drama && !isDroppedEpisode(drama) ? json({ drama }) : json({ error: 'Not found' }, 404)
  }
  // Resume a failed run whose performance already exists (e.g. the Workflow
  // died in post-production): reuse the artifact, rerun mandatory autotune and
  // bookend verification, then finalize/publish — no generation re-spend.
  const resume = pathname.match(/^\/api\/dramas\/([0-9a-f-]{36})\/resume$/)
  if (resume && request.method === 'POST') {
    const authorization = await operatorAuthorization(request, env.HNR_OPERATOR_TOKEN)
    if (authorization === 'disabled') return json({ error: 'Not found' }, 404)
    if (authorization !== 'authorized') return json({ error: 'Unauthorized' }, 401)
    const deployGate = await workflowDeployGateResponse(env)
    if (deployGate) return deployGate
    const drama = await getDrama(env.DB, resume[1])
    if (!drama) return json({ error: 'Not found' }, 404)
    if (drama.status !== 'failed' || !drama.artifactId) {
      return json({ error: 'Resume needs a failed episode with an existing performance (artifactId).' }, 400)
    }
    const workflowId = crypto.randomUUID()
    await env.PIPELINE.create({
      id: workflowId,
      params: {
        dramaId: drama.id,
        url: drama.url,
        resumeArtifactId: drama.artifactId,
        resumeRunId: workflowId,
      },
    })
    return json({ resumed: drama.id, workflowId })
  }
  // Re-run post-production against an existing performance without spending
  // on a new script/read. Used to repair optional effects or music that a
  // transient Worker subrequest-budget exhaustion skipped.
  const repair = pathname.match(/^\/api\/dramas\/([0-9a-f-]{36})\/repair$/)
  if (repair && request.method === 'POST') {
    const authorization = await operatorAuthorization(request, env.HNR_OPERATOR_TOKEN)
    if (authorization === 'disabled') return json({ error: 'Not found' }, 404)
    if (authorization !== 'authorized') return json({ error: 'Unauthorized' }, 401)
    const deployGate = await workflowDeployGateResponse(env)
    if (deployGate) return deployGate
    const drama = await getDrama(env.DB, repair[1])
    if (!drama?.artifactId) return json({ error: 'Repair needs an existing performance (artifactId).' }, 400)
    if (isDroppedEpisode(drama)) return json({ error: 'This episode was dropped; it is never repaired or published.' }, 409)
    let body
    try { body = await request.json() } catch { body = {} }
    const repairRunId = crypto.randomUUID()
    await env.PIPELINE.create({
      id: repairRunId,
      params: {
        dramaId: drama.id,
        url: drama.url,
        repairArtifactId: drama.artifactId,
        repairRunId,
        skipPublish: body?.publish !== true,
      },
    })
    return json({ repairing: drama.id, publish: body?.publish === true, workflowId: repairRunId })
  }
  if (pathname === '/api/generate' && request.method === 'POST') {
    if (!env.SLEEPERHIT_API_KEY) return json({ error: 'Server is missing SLEEPERHIT_API_KEY.' }, 500)
    let body
    try { body = await request.json() } catch { body = {} }
    if (!body?.url) return json({ error: 'Provide a Hacker News thread "url".' }, 400)
    const deployGate = await workflowDeployGateResponse(env)
    if (deployGate) return deployGate
    try {
      const result = await startGeneration(request, env, body.url, { force: Boolean(body.force) })
      return json(result)
    } catch (err) {
      if (String(err?.code || '').startsWith('community_')) {
        return json({ error: err.code, code: err.code, generatedHnId: err.generatedHnId || null }, 403)
      }
      if (err?.code === 'death_thread' || err?.code === 'episode_dropped') {
        return json({ error: err.message, code: err.code }, 422)
      }
      if (err?.code === 'show_not_ready' || err?.code === 'show_readiness_unavailable') {
        return json({ error: err.message, code: err.code, reason: err.reason ?? null }, 503, { 'Retry-After': '3600' })
      }
      return json({
        error: err?.message || String(err),
        code: err?.code || 'source_preflight_failed',
      }, 400)
    }
  }
  return json({ error: 'Not found' }, 404)
}

async function handleEpisodePage(request, env, url) {
  const raw = url.pathname.slice(3) // after '/e/'
  let drama = null
  if (/^\d+$/.test(raw)) {
    drama = await findByHnIdAndMode(env.DB, raw, 'podcast')
  } else if (/^[0-9a-f-]{36}$/.test(raw)) {
    const byGuid = await getDrama(env.DB, raw)
    if (byGuid?.hnId) return Response.redirect(`https://hnradio.net/e/${byGuid.hnId}`, 301)
  }
  if (isDroppedEpisode(drama)) drama = null
  const shell = await env.ASSETS.fetch(new Request(new URL('/index.html', url).toString()))
  if (!drama) return withHeaders(new Response(await shell.text(), { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } }))
  const title = `HNR — ${drama.title}`
  const desc = `Gary, Maeve, Obi, and Gruner read the Hacker News thread "${drama.title}" (${drama.commentCount} comments) so you don't have to.`
  const canonical = `https://hnradio.net/e/${drama.hnId}`
  const html = (await shell.text())
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(title)}</title>`)
    .replace(/(<link rel="canonical" href=")[^"]*(")/, `$1${esc(canonical)}$2`)
    .replace(/(<meta name="description" content=")[^"]*(")/, `$1${esc(desc)}$2`)
    .replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${esc(title)}$2`)
    .replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${esc(desc)}$2`)
    .replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${esc(canonical)}$2`)
    .replace(/(<meta name="twitter:title" content=")[^"]*(")/, `$1${esc(title)}$2`)
    .replace(/(<meta name="twitter:description" content=")[^"]*(")/, `$1${esc(desc)}$2`)
    .replace(/(<meta property="og:type" content=")[^"]*(")/, '$1music.song$2')
    .replace('</head>', `<meta property="og:audio" content="${esc(drama.audioUrl || '')}" /><meta property="og:audio:type" content="audio/mpeg" /></head>`)
  return withHeaders(new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }))
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(request, env, url)
      if (url.pathname.startsWith('/e/')) return await handleEpisodePage(request, env, url)
    } catch (err) {
      return json({ error: 'Internal error' }, 500)
    }
    return withHeaders(await env.ASSETS.fetch(request))
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runNightlyReconciliation(env, {
      now: new Date(event?.scheduledTime || Date.now()),
    }))
  },
}
