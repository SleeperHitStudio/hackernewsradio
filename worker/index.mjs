/**
 * hnradio on Cloudflare: one Worker serves the built SPA (ASSETS binding),
 * the /api/* surface, and /e/:hnId episode landing pages with server-rewritten
 * OG tags. Generation runs as a durable Workflow (see pipeline.mjs); the daily
 * 7pm America/Chicago sweep fires from an hourly cron trigger (DST-proof).
 */
import { listDramas, getDrama, findByHnIdAndMode, upsertDrama, deleteOtherEpisodesOfThread } from './store.mjs'
import { fetchThread } from './hn.mjs'

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
    "script-src 'self' https://us-assets.i.posthog.com; " +
    "connect-src 'self' https://us.i.posthog.com https://us-assets.i.posthog.com; frame-ancestors 'none'",
}

function withHeaders(res, extra = {}) {
  const out = new Response(res.body, res)
  for (const [k, v] of Object.entries({ ...SECURITY_HEADERS, ...extra })) out.headers.set(k, v)
  return out
}

const json = (data, status = 200) =>
  withHeaders(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }))

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

async function startGeneration(env, url, { force = false } = {}) {
  const thread = await fetchThread(url)
  if (!force) {
    const existing = await findByHnIdAndMode(env.DB, thread.id, 'podcast')
    if (existing && existing.status === 'ready') return { drama: existing, reused: true }
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
    progress: [{ at: new Date().toISOString(), message: `Fetched ${thread.total} comments` }],
    audioUrl: null,
    error: null,
    createdAt: new Date().toISOString(),
  }
  await upsertDrama(env.DB, drama)
  // A forced take replaces the visible episode immediately. Retiring older
  // rows here prevents stale failed/running cards from lingering for the full
  // generation window; stale workflows can no longer recreate deleted rows
  // because patchDrama only updates records that still exist.
  if (force) await deleteOtherEpisodesOfThread(env.DB, thread.id, 'podcast', drama.id)
  await env.PIPELINE.create({ id: drama.id, params: { dramaId: drama.id, url: thread.url } })
  return { drama, reused: false }
}

async function handleApi(request, env, url) {
  const { pathname } = url
  if (pathname === '/api/health') {
    return json({ ok: true, apiBase: env.SLEEPERHIT_API_BASE, hasKey: Boolean(env.SLEEPERHIT_API_KEY), platform: 'cloudflare' })
  }
  if (pathname === '/api/dramas' && request.method === 'GET') {
    const q = url.searchParams.get('q') ?? ''
    const includeFailed = url.searchParams.get('includeFailed') === 'true'
    return json({ dramas: await listDramas(env.DB, { q, includeFailed }) })
  }
  const one = pathname.match(/^\/api\/dramas\/([0-9a-f-]{36})$/)
  if (one && request.method === 'GET') {
    const drama = await getDrama(env.DB, one[1])
    return drama ? json({ drama }) : json({ error: 'Not found' }, 404)
  }
  // Resume a failed run whose performance already exists (e.g. the workflow
  // died at finalize): re-enters the pipeline in resume mode, skipping
  // straight to finalize on the existing artifact — no generation re-spend.
  const resume = pathname.match(/^\/api\/dramas\/([0-9a-f-]{36})\/resume$/)
  if (resume && request.method === 'POST') {
    const drama = await getDrama(env.DB, resume[1])
    if (!drama) return json({ error: 'Not found' }, 404)
    if (drama.status !== 'failed' || !drama.artifactId) {
      return json({ error: 'Resume needs a failed episode with an existing performance (artifactId).' }, 400)
    }
    await env.PIPELINE.create({
      id: crypto.randomUUID(),
      params: { dramaId: drama.id, url: drama.url, resumeArtifactId: drama.artifactId },
    })
    return json({ resumed: drama.id })
  }
  // Re-run post-production against an existing performance without spending
  // on a new script/read. Used to repair optional effects or music that a
  // transient Worker subrequest-budget exhaustion skipped.
  const repair = pathname.match(/^\/api\/dramas\/([0-9a-f-]{36})\/repair$/)
  if (repair && request.method === 'POST') {
    const drama = await getDrama(env.DB, repair[1])
    if (!drama?.artifactId) return json({ error: 'Repair needs an existing performance (artifactId).' }, 400)
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
    return json({ repairing: drama.id, publish: body?.publish === true })
  }
  if (pathname === '/api/generate' && request.method === 'POST') {
    if (!env.SLEEPERHIT_API_KEY) return json({ error: 'Server is missing SLEEPERHIT_API_KEY.' }, 500)
    let body
    try { body = await request.json() } catch { body = {} }
    if (!body?.url) return json({ error: 'Provide a Hacker News thread "url".' }, 400)
    try {
      const result = await startGeneration(env, body.url, { force: Boolean(body.force) })
      return json(result)
    } catch (err) {
      return json({ error: err?.message || String(err) }, 400)
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

/** Daily sweep: top 5 discussed front-page threads at 19:00 America/Chicago. */
async function dailySweep(env) {
  const { getSetting, setSetting } = await import('./store.mjs')
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
  }).formatToParts(new Date())
  const get = (t) => parts.find((p) => p.type === t)?.value
  const date = `${get('year')}-${get('month')}-${get('day')}`
  if (get('hour') !== '19') return
  if ((await getSetting(env.DB, 'dailyTopLastRun')) === date) return
  await setSetting(env.DB, 'dailyTopLastRun', date)

  const ids = (await (await fetch('https://hacker-news.firebaseio.com/v0/topstories.json')).json()).slice(0, 30)
  const picked = []
  for (const id of ids) {
    if (picked.length >= 5) break
    try {
      const item = await (await fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`)).json()
      if (item?.type === 'story' && (item.descendants ?? 0) >= 10) picked.push(item)
    } catch { /* pool has slack */ }
  }
  let i = 0
  for (const story of picked) {
    const url = `https://news.ycombinator.com/item?id=${story.id}`
    try {
      const existing = await findByHnIdAndMode(env.DB, story.id, 'podcast')
      if (existing && existing.status === 'ready') continue
      const thread = await fetchThread(url)
      const drama = {
        id: crypto.randomUUID(), hnId: thread.id, mode: 'podcast', url: thread.url,
        title: thread.title, commentCount: thread.total, points: thread.points ?? null,
        status: 'queued',
        progress: [{ at: new Date().toISOString(), message: `Fetched ${thread.total} comments` }],
        audioUrl: null, error: null, createdAt: new Date().toISOString(),
      }
      await upsertDrama(env.DB, drama)
      // 10-minute stagger ≈ serialized episodes: keeps platform load flat and
      // the length-gate rerolls (pipeline.mjs) from stacking up. (The first
      // sweep's short episodes turned out to be thin WRITING, not truncation.)
      await env.PIPELINE.create({ id: drama.id, params: { dramaId: drama.id, url: thread.url, staggerSec: i * 600 } })
      i++
    } catch { /* next story */ }
  }
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
    ctx.waitUntil(dailySweep(env))
  },
}
