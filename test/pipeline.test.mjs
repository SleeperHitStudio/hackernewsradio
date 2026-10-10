import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

// The Workflow imports `cloudflare:workers`, which only exists inside the
// Workers runtime. Resolve it to a stand-in base class so the real pipeline
// runs here against a fake Story API, a fake D1, and a step that behaves like
// Cloudflare's: results are serialized, and a thrown step error comes back as
// a bare Error with its message only.
const workersStub = 'data:text/javascript,' + encodeURIComponent(
  'export class WorkflowEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env } }',
)
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') return { url: ${JSON.stringify(workersStub)}, shortCircuit: true }
  return next(specifier, context)
}`))
const { HnrPipeline } = await import('../worker/pipeline.mjs')
const { classifySystemicFailure, isTransientSourceFailure } = await import('../worker/failure-classification.mjs')
const { PUBLISHED_PROGRESS_MESSAGE } = await import('../worker/publishing.mjs')
const { PUBLISH_BLOCKED_ALERT_KEY } = await import('../worker/alerts.mjs')

const API = 'https://api.example.test'
const PROJECT = 'project_hnr'
const SERIES = 'series_hnr'

function fakeD1({ episodes = [], settings = {} } = {}) {
  const rows = new Map(episodes.map((episode) => [episode.id, structuredClone(episode)]))
  const store = new Map(Object.entries(settings).map(([key, value]) => [key, structuredClone(value)]))
  return {
    rows,
    store,
    prepare(sql) {
      const q = sql.replace(/\s+/g, ' ').trim()
      return {
        bind(...values) {
          return {
            async all() {
              if (q.startsWith('SELECT data FROM episodes WHERE hn_id')) {
                const [hnId, mode, exceptId] = values
                const results = [...rows.values()]
                  .filter((row) => String(row.hnId) === hnId && (row.mode || 'podcast') === mode && row.id !== exceptId
                    && ['queued', 'running'].includes(row.status))
                  .map((row) => ({ data: JSON.stringify(row) }))
                return { results }
              }
              throw new Error(`Unexpected D1 list: ${q}`)
            },
            async first() {
              if (q.startsWith('SELECT data FROM episodes WHERE id')) {
                const row = rows.get(values[0])
                return row ? { data: JSON.stringify(row) } : null
              }
              if (q.startsWith('SELECT value FROM settings')) {
                return store.has(values[0]) ? { value: JSON.stringify(store.get(values[0])) } : null
              }
              throw new Error(`Unexpected D1 read: ${q}`)
            },
            async run() {
              if (q.startsWith('INSERT INTO episodes')) {
                // The real upsert never rewrites a dropped row (store.mjs DROPPED_STATUS).
                if (q.includes("WHERE episodes.status <> 'dropped'") && rows.get(values[0])?.status === 'dropped') {
                  return { meta: { changes: 0 } }
                }
                rows.set(values[0], JSON.parse(values[6]))
                return { meta: { changes: 1 } }
              }
              if (q.startsWith('INSERT INTO settings') && q.includes('WHERE settings.value IS NULL')) {
                // claimSetting: only an unset key is claimed.
                if (store.has(values[0]) && store.get(values[0]) !== null) return { meta: { changes: 0 } }
                store.set(values[0], JSON.parse(values[1]))
                return { meta: { changes: 1 } }
              }
              if (q.startsWith('INSERT INTO settings')) {
                store.set(values[0], JSON.parse(values[1]))
                return { meta: { changes: 1 } }
              }
              if (q.startsWith('DELETE FROM episodes')) return { meta: { changes: 0 } }
              throw new Error(`Unexpected D1 write: ${q}`)
            },
          }
        },
      }
    },
  }
}

/** A step that behaves like Cloudflare's across the step boundary. */
function cloudflareStep(seed = {}) {
  const results = new Map(Object.entries(seed))
  return {
    labels: [],
    async do(label, config, fn) {
      const callback = typeof config === 'function' ? config : fn
      this.labels.push(label)
      if (results.has(label)) return structuredClone(results.get(label))
      const limit = typeof config === 'object' ? Number(config?.retries?.limit ?? 0) : 0
      let lastError
      for (let attempt = 0; attempt <= limit; attempt++) {
        try {
          const value = await callback()
          const stored = value === undefined ? undefined : JSON.parse(JSON.stringify(value))
          results.set(label, stored)
          return stored
        } catch (error) {
          lastError = error
        }
      }
      throw new Error(lastError?.message || String(lastError))
    },
    async sleep() {},
  }
}

/** Route Story API + Resend calls to a handler; record every request. */
function fakeNetwork(t, handler) {
  const requests = []
  const emails = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url)
    const body = options.body ? JSON.parse(options.body) : undefined
    if (target.startsWith('https://api.resend.com/')) {
      emails.push(body)
      return { ok: true, status: 200, text: async () => '{}', json: async () => ({}) }
    }
    const path = target.replace(`${API}/api/v1`, '')
    const request = {
      method: options.method || 'GET',
      path,
      key: options.headers?.['Idempotency-Key'] ?? null,
      body,
    }
    requests.push(request)
    const [status, payload] = await handler(request, requests)
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(payload ?? {}),
    }
  }
  t.after(() => { globalThis.fetch = realFetch })
  return { requests, emails }
}

const refusal = (status, code, message, details) => [status, { error: { code, message, requestId: 'req_1', ...(details ? { details } : {}) } }]

const KEY_ID = 'key_hnr'
const GRANTED_AT = '2026-09-29T00:00:00.000Z'
// The platform's (PR 6) series shape: the grant names the ONE key it is bound to.
const GRANTED_SERIES = {
  id: SERIES,
  status: 'active',
  medium: 'audio',
  standingApproval: { keyId: KEY_ID, keyName: 'HNR', keyStart: 'sh_te', grantedAt: GRANTED_AT, grantedBy: 'user_owner' },
}

function envFor(db, extra = {}) {
  return {
    DB: db,
    SLEEPERHIT_API_BASE: API,
    SLEEPERHIT_API_KEY: 'sh_test',
    SLEEPERHIT_API_KEY_ID: KEY_ID,
    HNRADIO_PROJECT_ID: PROJECT,
    ...extra,
  }
}

/** Answer the series read with `series` (the standing approval), and hand everything else on. */
function underGrant(handler, series = GRANTED_SERIES) {
  return (request, requests) => {
    if (request.method === 'GET' && request.path === `/publishing-series/${SERIES}`) {
      return typeof series === 'function' ? series(request, requests) : [200, { series }]
    }
    return handler(request, requests)
  }
}

function completeThread(id = '42', count = 50) {
  const comments = Array.from({ length: count }, (_, index) => ({
    id: `${id}${String(index + 1).padStart(3, '0')}`,
    parentId: null,
    branch: `${id}${String(index + 1).padStart(3, '0')}`,
    author: `user${index + 1}`,
    depth: 0,
    text: `Complete comment ${index + 1}`,
  }))
  return {
    id,
    title: `Story ${id}`,
    url: `https://news.ycombinator.com/item?id=${id}`,
    articleUrl: null,
    storyText: 'Complete self-post body.',
    author: 'submitter',
    postedAt: '2026-09-30T23:30:00.000Z',
    comments,
    total: count,
    points: 100,
    completeness: {
      comments: {
        complete: true,
        expected: count,
        fetched: count,
        capturedAt: '2026-09-29T00:00:00.000Z',
        metadataSource: 'official-hn-firebase',
        contentSource: 'hn-algolia-search-plus-recursive-item-tree',
      },
    },
  }
}

const PINNED = {
  GARY: { voiceId: 'v_gary', voiceName: 'Gary', provider: 'elevenlabs' },
  MAEVE: { voiceId: 'v_maeve', voiceName: 'Maeve', provider: 'elevenlabs' },
  OBI: { voiceId: 'v_obi', voiceName: 'Obi', provider: 'elevenlabs' },
  GRUNER: { voiceId: 'v_gruner', voiceName: 'Gruner', provider: 'hume' },
}

const FACES_ONLY_CANON = {
  canon: {
    content: {
      characters: ['GARY', 'MAEVE', 'OBI', 'GRUNER'].map((name) => ({
        name,
        avatarUrl: `https://hnradio.net/avatars/${name.toLowerCase()}.png`,
        bodyFigureUrl: `https://files.example/${name}.png`,
      })),
    },
  },
}

const GATE_REFUSAL = refusal(409, 'project_precondition_failed',
  'Pass full Series Bible coverage before starting episodes, project videos, or publishing.',
  { stage: 'full_coverage', missingFields: [], canPlan: true, canStartEpisode: false })

async function runPipeline(env, payload, step = cloudflareStep()) {
  const pipeline = new HnrPipeline({}, env)
  let error = null
  try {
    await pipeline.run({ payload, instanceId: `run_${payload.dramaId}` }, step)
  } catch (caught) {
    error = caught
  }
  return { error, step }
}

function newEpisode(id = 'drama_1') {
  return { id, hnId: '42', mode: 'podcast', status: 'queued', title: 'Story 42', url: 'https://news.ycombinator.com/item?id=42', progress: [], createdAt: '2026-09-29T00:00:00.000Z' }
}

test('a new episode writes the canon voices, sends the thread identity, reuses a captured source, and STOPS on a typed 409', async (t) => {
  const db = fakeD1({ episodes: [newEpisode()], settings: { pinnedVoices: PINNED, publishingSeriesId: SERIES } })
  const net = fakeNetwork(t, underGrant((request) => {
    if (request.method === 'GET' && request.path === `/story-projects/${PROJECT}/cast-canon`) return [200, FACES_ONLY_CANON]
    if (request.method === 'PATCH' && request.path === `/story-projects/${PROJECT}/cast-canon`) return [200, { canon: {} }]
    if (request.method === 'POST' && request.path === `/story-projects/${PROJECT}/sources`) {
      return [200, {
        deduplicated: true,
        source: { id: 'source_first', status: 'READY', metadata: { sourceCompleteness: { comments: { fetched: 48 } } } },
      }]
    }
    if (request.path === `/story-projects/${PROJECT}/sources/source_first`) return [200, { source: { id: 'source_first', status: 'READY' } }]
    if (request.method === 'POST' && request.path === `/story-projects/${PROJECT}/story-plans`) return GATE_REFUSAL
    throw new Error(`unexpected ${request.method} ${request.path}`)
  }))

  const { error } = await runPipeline(envFor(db), { dramaId: 'drama_1', url: 'https://news.ycombinator.com/item?id=42' },
    cloudflareStep({ 'fetch complete thread': completeThread('42', 50) }))

  assert.ok(error, 'the refusal ends the run')
  assert.equal(net.requests[0].path, `/publishing-series/${SERIES}`, 'the grant is read before anything is spent')

  // Cast canon: the hosts' voices, only keys the strict schema accepts, and
  // never the portrait-style key that 400'd every PATCH since 07-15.
  const patch = net.requests.find((r) => r.method === 'PATCH')
  assert.deepEqual(Object.keys(patch.body), ['content'])
  assert.deepEqual(Object.keys(patch.body.content), ['characters'])
  assert.deepEqual(patch.body.content.characters.find((c) => c.name === 'GRUNER'), {
    name: 'GRUNER',
    avatarUrl: 'https://hnradio.net/avatars/gruner.png',
    voiceId: 'v_gruner',
    voiceProvider: 'hume',
  })

  // Source: identity is top-level, not smuggled in metadata.
  const upload = net.requests.find((r) => r.path === `/story-projects/${PROJECT}/sources`)
  assert.equal(upload.body.producer, 'hackernewsradio')
  assert.equal(upload.body.externalId, '42')
  assert.equal('sourceProducer' in upload.body.metadata, false)
  assert.equal('hnStoryId' in upload.body.metadata, false)
  assert.equal(upload.body.metadata.sourceContextMode, 'full')
  // When the thread was posted, top-level: the platform files the episode in
  // that month's season, not the month it was captured or aired.
  assert.equal(upload.body.originatedAt, '2026-09-30T23:30:00.000Z')
  assert.equal(net.requests.some((r) => r.method === 'DELETE'), false, 'no recapture without a failed-before-plan attempt')

  // A 409 project_precondition_failed is STATE: one plan request, no retry.
  const plans = net.requests.filter((r) => r.path === `/story-projects/${PROJECT}/story-plans`)
  assert.equal(plans.length, 1, 'the typed 409 is not retried')

  const drama = db.rows.get('drama_1')
  assert.equal(drama.status, 'failed')
  assert.equal(drama.failureClass, 'project_not_ready')
  assert.equal(drama.failureCode, 'project_precondition_failed', 'the code survives the step boundary')
  assert.equal(drama.sourceId, 'source_first')
  assert.equal(drama.sourceDeduplicated, true)
  // The row records what the episode is written FROM: the reused capture.
  assert.deepEqual(drama.sourceCompleteness, { comments: { fetched: 48 } })
  assert.equal(drama.commentCount, 48)
  assert.ok(Number.isFinite(Date.parse(drama.failedAt)), 'the failure is stamped for the nightly')
  assert.ok(drama.progress.some((p) => /Reusing the source already captured for HN thread 42 \(48 comments\)/.test(p.message)))
})

// INDEX LAG, CONVERGED BEFORE UPLOAD (2026-10-04): two of three uploads that night were refused because a
// capture inside tolerance was a comment short ("70/71 (index lag)") and the Story API proves a source by
// EQUAL counts. The pipeline re-fetches a lagging thread (10 s, 20 s, 30 s) and uploads only a whole one.
function laggingThread(id = '42', expected = 51, fetched = 50) {
  const thread = completeThread(id, fetched)
  thread.completeness.comments = { ...thread.completeness.comments, complete: false, expected, fetched }
  return thread
}

function recordingStep(seed) {
  const step = cloudflareStep(seed)
  step.sleeps = []
  step.sleep = async (label, duration) => { step.sleeps.push([label, duration]) }
  return step
}

const LAG_RUN_HANDLER = (request) => {
  if (request.method === 'GET' && request.path === `/story-projects/${PROJECT}/cast-canon`) return [200, FACES_ONLY_CANON]
  if (request.method === 'PATCH' && request.path === `/story-projects/${PROJECT}/cast-canon`) return [200, { canon: {} }]
  if (request.method === 'POST' && request.path === `/story-projects/${PROJECT}/sources`) {
    return [200, { deduplicated: false, source: { id: 'source_whole', status: 'READY' } }]
  }
  if (request.path === `/story-projects/${PROJECT}/sources/source_whole`) return [200, { source: { id: 'source_whole', status: 'READY' } }]
  if (request.method === 'POST' && request.path === `/story-projects/${PROJECT}/story-plans`) return GATE_REFUSAL
  throw new Error(`unexpected ${request.method} ${request.path}`)
}

test('a lagging capture that converges on the second re-fetch uploads once, whole', async (t) => {
  const db = fakeD1({ episodes: [newEpisode()], settings: { pinnedVoices: PINNED, publishingSeriesId: SERIES } })
  const net = fakeNetwork(t, underGrant(LAG_RUN_HANDLER))
  const step = recordingStep({
    'fetch complete thread': laggingThread('42', 51, 50),
    'refetch lagging thread 1': laggingThread('42', 51, 50),
    'refetch lagging thread 2': completeThread('42', 51),
  })

  await runPipeline(envFor(db), { dramaId: 'drama_1', url: 'https://news.ycombinator.com/item?id=42' }, step)

  const uploads = net.requests.filter((r) => r.method === 'POST' && r.path === `/story-projects/${PROJECT}/sources`)
  assert.equal(uploads.length, 1, 'one upload')
  assert.deepEqual(
    [uploads[0].body.metadata.sourceCompleteness.comments.expected, uploads[0].body.metadata.sourceCompleteness.comments.fetched],
    [51, 51], 'and it is the whole thread')
  assert.deepEqual(step.sleeps, [['index lag wait 1', '10 seconds'], ['index lag wait 2', '20 seconds']], 'backoff, not a tight loop')
  assert.equal(step.labels.includes('refetch lagging thread 3'), false)
  const drama = db.rows.get('drama_1')
  assert.ok(drama.progress.some((p) => /HN thread 42 is 50\/51 \(index lag\); re-fetching in 10 s/.test(p.message)))
})

test('a capture that never converges uploads nothing and fails as source lag, the free hold', async (t) => {
  const db = fakeD1({ episodes: [newEpisode()], settings: { pinnedVoices: PINNED, publishingSeriesId: SERIES } })
  const net = fakeNetwork(t, underGrant(LAG_RUN_HANDLER))
  const step = recordingStep({
    'fetch complete thread': laggingThread('42', 71, 70),
    'refetch lagging thread 1': laggingThread('42', 71, 70),
    'refetch lagging thread 2': laggingThread('42', 71, 70),
    'refetch lagging thread 3': laggingThread('42', 72, 71),
  })

  const { error } = await runPipeline(envFor(db), { dramaId: 'drama_1', url: 'https://news.ycombinator.com/item?id=42' }, step)

  assert.match(error?.message || '', /is not synchronized yet: 71\/72 comments after 3 re-fetches/)
  assert.equal(net.requests.some((r) => r.method === 'POST' && r.path.endsWith('/sources')), false, 'a capture the platform would refuse is never uploaded')
  assert.equal(step.sleeps.length, 3, 'about a minute, then it stops')
  const drama = db.rows.get('drama_1')
  assert.equal(drama.status, 'failed')
  assert.equal(drama.failureCode, 'hn_thread_incomplete')
  // The nightly holds it for free and retries next tick (no attempt spent, no circuit).
  assert.equal(isTransientSourceFailure(drama), true)
  assert.equal(classifySystemicFailure(drama), null)
})

test('a whole capture is uploaded at once, with no re-fetch and no wait', async (t) => {
  const db = fakeD1({ episodes: [newEpisode()], settings: { pinnedVoices: PINNED, publishingSeriesId: SERIES } })
  const net = fakeNetwork(t, underGrant(LAG_RUN_HANDLER))
  const step = recordingStep({ 'fetch complete thread': completeThread('42', 50) })

  await runPipeline(envFor(db), { dramaId: 'drama_1', url: 'https://news.ycombinator.com/item?id=42' }, step)

  assert.equal(step.labels.some((label) => label.startsWith('refetch lagging thread')), false)
  assert.deepEqual(step.sleeps, [])
  assert.equal(net.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/sources')).length, 1)
})

test('a cast canon refusal fails the episode instead of being swallowed', async (t) => {
  const db = fakeD1({ episodes: [newEpisode()], settings: { pinnedVoices: PINNED, publishingSeriesId: SERIES } })
  const net = fakeNetwork(t, underGrant((request) => {
    if (request.method === 'GET' && request.path.endsWith('/cast-canon')) return [200, FACES_ONLY_CANON]
    if (request.method === 'PATCH') return refusal(400, 'validation_failed', 'Invalid key in record: avatarStyle')
    throw new Error(`unexpected ${request.method} ${request.path}`)
  }))

  const { error } = await runPipeline(envFor(db), { dramaId: 'drama_1', url: 'https://news.ycombinator.com/item?id=42' },
    cloudflareStep({ 'fetch complete thread': completeThread('42', 50) }))

  assert.match(error?.message || '', /Invalid key in record/)
  assert.equal(net.requests.some((r) => r.path.endsWith('/sources')), false, 'nothing is uploaded after the refusal')
  const drama = db.rows.get('drama_1')
  assert.equal(drama.status, 'failed')
  assert.equal(drama.failureClass, 'contract')
  assert.equal(drama.failureCode, 'validation_failed')
})

const CURRENT_CANON = [200, { canon: { content: { characters: Object.entries(PINNED).map(([name, v]) => ({
  name, avatarUrl: `https://hnradio.net/avatars/${name.toLowerCase()}.png`, voiceId: v.voiceId, voiceProvider: v.provider,
})) } } }]

test('a thread that grew after a failed-before-plan attempt is recaptured: DELETE, then a fresh POST', async (t) => {
  const db = fakeD1({ episodes: [newEpisode()], settings: { pinnedVoices: PINNED, publishingSeriesId: SERIES } })
  let posts = 0
  const net = fakeNetwork(t, underGrant((request) => {
    if (request.method === 'GET' && request.path.endsWith('/cast-canon')) {
      return [200, { canon: { content: { characters: Object.entries(PINNED).map(([name, v]) => ({
        name, avatarUrl: `https://hnradio.net/avatars/${name.toLowerCase()}.png`, voiceId: v.voiceId, voiceProvider: v.provider,
      })) } } }]
    }
    if (request.method === 'POST' && request.path === `/story-projects/${PROJECT}/sources`) {
      posts++
      return posts === 1
        ? [200, { deduplicated: true, source: { id: 'source_stale', status: 'READY', metadata: { sourceCompleteness: { comments: { fetched: 20 } } } } }]
        : [200, { source: { id: 'source_fresh', status: 'READY' } }]
    }
    if (request.method === 'DELETE') return [200, { deleted: true }]
    if (request.path.startsWith(`/story-projects/${PROJECT}/sources/`)) return [200, { source: { status: 'READY' } }]
    if (request.path === `/story-projects/${PROJECT}/story-plans`) return GATE_REFUSAL
    throw new Error(`unexpected ${request.method} ${request.path}`)
  }))

  await runPipeline(envFor(db), {
    dramaId: 'drama_1',
    url: 'https://news.ycombinator.com/item?id=42',
    sourceRecapture: { previousCommentCount: 20 },
  }, cloudflareStep({ 'fetch complete thread': completeThread('42', 50) }))

  assert.equal(net.requests.some((r) => r.method === 'PATCH'), false, 'a current canon is not rewritten')
  const deletes = net.requests.filter((r) => r.method === 'DELETE')
  assert.deepEqual(deletes.map((r) => r.path), [`/story-projects/${PROJECT}/sources/source_stale`])
  const uploads = net.requests.filter((r) => r.method === 'POST' && r.path === `/story-projects/${PROJECT}/sources`)
  assert.deepEqual(uploads.map((r) => r.key), ['drama_1-source', 'drama_1-source-recapture'])
  const drama = db.rows.get('drama_1')
  assert.equal(drama.sourceId, 'source_fresh')
  assert.equal(drama.sourceCompleteness.comments.fetched, 50, 'a recapture records the thread fetched this run')
})

test('a stale capture is never retired while another episode of the thread is in flight', async (t) => {
  const sibling = { ...newEpisode('drama_visitor'), status: 'running', createdAt: '2026-09-29T00:05:00.000Z' }
  const db = fakeD1({ episodes: [newEpisode(), sibling], settings: { pinnedVoices: PINNED, publishingSeriesId: SERIES } })
  const net = fakeNetwork(t, underGrant((request) => {
    if (request.method === 'GET' && request.path.endsWith('/cast-canon')) return CURRENT_CANON
    if (request.method === 'POST' && request.path === `/story-projects/${PROJECT}/sources`) {
      return [200, { deduplicated: true, source: { id: 'source_shared', status: 'READY', metadata: { sourceCompleteness: { comments: { fetched: 20 } } } } }]
    }
    if (request.path.startsWith(`/story-projects/${PROJECT}/sources/`)) return [200, { source: { status: 'READY' } }]
    if (request.path === `/story-projects/${PROJECT}/story-plans`) return GATE_REFUSAL
    throw new Error(`unexpected ${request.method} ${request.path}`)
  }))

  await runPipeline(envFor(db), {
    dramaId: 'drama_1',
    url: 'https://news.ycombinator.com/item?id=42',
    sourceRecapture: { previousCommentCount: 20 },
  }, cloudflareStep({ 'fetch complete thread': completeThread('42', 50) }))

  assert.equal(net.requests.some((r) => r.method === 'DELETE'), false, 'the visitor episode may be planning from it')
  const drama = db.rows.get('drama_1')
  assert.equal(drama.sourceId, 'source_shared')
  assert.ok(drama.progress.some((p) => /drama_visitor of this thread is in flight/.test(p.message)))
})

function recoveredEpisode(extra = {}) {
  return {
    id: 'drama_1', hnId: '42', mode: 'podcast', status: 'failed', title: 'Story 42',
    url: 'https://news.ycombinator.com/item?id=42', commentCount: 50, points: 100,
    planId: 'plan_1', progress: [], createdAt: '2026-09-29T00:00:00.000Z', ...extra,
  }
}

test('a 402 on the job stops the run and keeps the exact request; the recovery re-sends the SAME key and body', async (t) => {
  const db = fakeD1({ episodes: [recoveredEpisode()], settings: { pinnedVoices: PINNED, publishingSeriesId: SERIES } })
  const net = fakeNetwork(t, underGrant((request) => {
    if (request.path === '/story-plans/plan_1/resume') return [200, { plan: { id: 'plan_1', status: 'APPROVED' } }]
    if (request.path === '/story-plans/plan_1') return [200, { plan: { id: 'plan_1', status: 'APPROVED' } }]
    if (request.path === '/story-jobs') {
      return refusal(402, 'insufficient_credits', 'Not enough Studio Credits. This job needs 30 credits; you have 4.',
        { required: 30, available: 4, jobId: null })
    }
    throw new Error(`unexpected ${request.method} ${request.path}`)
  }))

  const first = await runPipeline(envFor(db), {
    dramaId: 'drama_1', url: 'https://news.ycombinator.com/item?id=42', resumePlanId: 'plan_1', recoveryRunId: 'rec_1',
  })
  assert.ok(first.error)
  const jobs = net.requests.filter((r) => r.path === '/story-jobs')
  assert.equal(jobs.length, 1, 'no retry can buy credits: exactly one job request')
  const drama = db.rows.get('drama_1')
  assert.equal(drama.failureClass, 'quota')
  assert.equal(drama.failureCode, 'insufficient_credits')
  assert.equal(drama.pendingJob.key, 'drama_1-recovery-rec_1-job-r1-j0')
  assert.equal(drama.pendingJob.planId, 'plan_1')
  assert.equal(drama.pendingJob.required, 30, 'what THIS job costs, for the nightly\'s credit floor')
  assert.deepEqual(drama.pendingJob.body, jobs[0].body)

  // The recovery after a top-up: a NEW run id, the SAME job request.
  await runPipeline(envFor(db), {
    dramaId: 'drama_1',
    url: 'https://news.ycombinator.com/item?id=42',
    resumePlanId: 'plan_1',
    jobKey: drama.pendingJob.key,
    recoveryRunId: 'rec_2',
  })
  const resent = net.requests.filter((r) => r.path === '/story-jobs')
  assert.equal(resent.length, 2)
  assert.equal(resent[1].key, 'drama_1-recovery-rec_1-job-r1-j0')
  assert.deepEqual(resent[1].body, resent[0].body, 'the body is replayed verbatim, so the key cannot conflict')
})

function approvalRoutes({ approveSeries = GRANTED_SERIES } = {}) {
  return (request) => {
    if (request.path === '/story-plans/plan_1/resume') return [200, { plan: { id: 'plan_1', status: 'REQUIRES_APPROVAL' } }]
    if (request.path === '/story-plans/plan_1') return [200, { plan: { id: 'plan_1', status: 'REQUIRES_APPROVAL' } }]
    if (request.path === '/story-plans/plan_1/approve') return [200, { plan: { id: 'plan_1', status: 'APPROVED' } }]
    if (request.path === '/story-jobs') return refusal(402, 'insufficient_credits', 'Not enough Studio Credits.')
    throw new Error(`unexpected ${request.method} ${request.path}`)
  }
}

test('under the series\' standing approval, plan approval claims no human confirmation', async (t) => {
  const db = fakeD1({ episodes: [recoveredEpisode()], settings: { pinnedVoices: PINNED, publishingSeriesId: SERIES } })
  const net = fakeNetwork(t, underGrant(approvalRoutes()))
  await runPipeline(envFor(db), {
    dramaId: 'drama_1', url: 'https://news.ycombinator.com/item?id=42', resumePlanId: 'plan_1', recoveryRunId: 'rec_1',
  })
  const approve = net.requests.find((r) => r.path === '/story-plans/plan_1/approve')
  assert.deepEqual(approve.body, {}, 'the grant is the approval')
  const seriesReads = net.requests.filter((r) => r.path === `/publishing-series/${SERIES}`)
  assert.equal(seriesReads.length, 2, 'read before spending, and again at the moment of approval')
})

// Every way the grant can fail to cover HNR. None of them approves, and none
// of them spends: no source, no plan, no approve, no job.
for (const [label, series, settings, env, code] of [
  ['the platform does not report a grant', [200, { series: { id: SERIES, status: 'active', medium: 'audio' } }], {}, {}, 'standing_approval_unavailable'],
  ['the grant was revoked (null)', [200, { series: { ...GRANTED_SERIES, standingApproval: null } }], {}, {}, 'standing_approval_missing'],
  ['the grant is bound to another key', [200, { series: { ...GRANTED_SERIES, standingApproval: { ...GRANTED_SERIES.standingApproval, keyId: 'key_other' } } }], {}, {}, 'standing_approval_other_key'],
  ['only the built-in runner holds the grant', [200, { series: { ...GRANTED_SERIES, standingApproval: { ...GRANTED_SERIES.standingApproval, keyId: null } } }], {}, {}, 'standing_approval_other_key'],
  ['the series is paused', [200, { series: { ...GRANTED_SERIES, status: 'paused' } }], {}, {}, 'standing_approval_inactive'],
  ['the series read is refused', refusal(403, 'insufficient_scope', 'Missing publishing:read'), {}, {}, 'standing_approval_unreadable'],
  ['the series cannot be read at all', [503, { error: { message: 'Service Unavailable' } }], {}, {}, 'standing_approval_unreadable'],
  ['HNR does not know its own key id', [200, { series: GRANTED_SERIES }], {}, { SLEEPERHIT_API_KEY_ID: '' }, 'standing_approval_unverifiable'],
  ['no publishing series is configured', [200, { series: GRANTED_SERIES }], { publishingSeriesId: null }, {}, 'publishing_series_missing'],
]) {
  for (const [kind, payload] of [
    ['a new episode', { dramaId: 'drama_1', url: 'https://news.ycombinator.com/item?id=42' }],
    ['a plan recovery', { dramaId: 'drama_1', url: 'https://news.ycombinator.com/item?id=42', resumePlanId: 'plan_1', recoveryRunId: 'rec_1' }],
  ]) {
    test(`${label}: ${kind} stops before spending — no source, plan, approve or job`, async (t) => {
      const episode = payload.resumePlanId ? recoveredEpisode() : newEpisode()
      const db = fakeD1({ episodes: [episode], settings: { pinnedVoices: PINNED, publishingSeriesId: SERIES, ...settings } })
      const net = fakeNetwork(t, underGrant(() => { throw new Error('nothing but the series read may be called') }, () => series))

      const { error } = await runPipeline(envFor(db, env), payload,
        cloudflareStep({ 'fetch complete thread': completeThread('42', 50) }))

      assert.ok(error, 'the run stops')
      assert.equal(net.requests.every((r) => r.method === 'GET' && r.path === `/publishing-series/${SERIES}`), true,
        `only the grant was read: ${net.requests.map((r) => `${r.method} ${r.path}`).join(', ')}`)
      const drama = db.rows.get('drama_1')
      assert.equal(drama.status, 'failed')
      assert.equal(drama.failureClass, 'approval_missing')
      assert.equal(drama.failureCode, code)
    })
  }
}

test('a grant revoked while the plan was generating stops at approval: no approve, no job', async (t) => {
  const db = fakeD1({ episodes: [recoveredEpisode()], settings: { pinnedVoices: PINNED, publishingSeriesId: SERIES } })
  let reads = 0
  const net = fakeNetwork(t, underGrant(approvalRoutes(), () => {
    reads++
    return [200, { series: reads === 1 ? GRANTED_SERIES : { ...GRANTED_SERIES, standingApproval: null } }]
  }))
  const { error } = await runPipeline(envFor(db), {
    dramaId: 'drama_1', url: 'https://news.ycombinator.com/item?id=42', resumePlanId: 'plan_1', recoveryRunId: 'rec_1',
  })
  assert.match(error?.message || '', /standing approval/)
  assert.equal(net.requests.some((r) => r.path.endsWith('/approve')), false)
  assert.equal(net.requests.some((r) => r.path === '/story-jobs'), false)
  assert.equal(db.rows.get('drama_1').failureClass, 'approval_missing')
})

test('a typed 4xx on plan creation stops the run: a fresh plan earns the same refusal', async (t) => {
  const db = fakeD1({ episodes: [newEpisode()], settings: { pinnedVoices: PINNED, publishingSeriesId: SERIES } })
  const net = fakeNetwork(t, underGrant((request) => {
    if (request.method === 'GET' && request.path.endsWith('/cast-canon')) return CURRENT_CANON
    if (request.method === 'POST' && request.path === `/story-projects/${PROJECT}/sources`) return [200, { source: { id: 'source_1', status: 'READY' } }]
    if (request.path.startsWith(`/story-projects/${PROJECT}/sources/`)) return [200, { source: { status: 'READY' } }]
    if (request.path === `/story-projects/${PROJECT}/story-plans`) return refusal(400, 'validation_failed', '`title` must be 200 characters or fewer.')
    throw new Error(`unexpected ${request.method} ${request.path}`)
  }))
  const { error } = await runPipeline(envFor(db), { dramaId: 'drama_1', url: 'https://news.ycombinator.com/item?id=42' },
    cloudflareStep({ 'fetch complete thread': completeThread('42', 50) }))
  assert.match(error?.message || '', /200 characters/)
  assert.equal(net.requests.filter((r) => r.path === `/story-projects/${PROJECT}/story-plans`).length, 1, 'not re-planned four times')
})

test('a typed 4xx on job creation stops the run: another job earns the same refusal', async (t) => {
  const db = fakeD1({ episodes: [recoveredEpisode()], settings: { pinnedVoices: PINNED, publishingSeriesId: SERIES } })
  const net = fakeNetwork(t, underGrant((request) => {
    if (request.path === '/story-plans/plan_1/resume') return [200, { plan: { id: 'plan_1', status: 'APPROVED' } }]
    if (request.path === '/story-plans/plan_1') return [200, { plan: { id: 'plan_1', status: 'APPROVED' } }]
    if (request.path === '/story-jobs') return refusal(409, 'story_plan_state_invalid', 'Story plan must be APPROVED before a job starts.')
    throw new Error(`unexpected ${request.method} ${request.path}`)
  }))
  const { error } = await runPipeline(envFor(db), {
    dramaId: 'drama_1', url: 'https://news.ycombinator.com/item?id=42', resumePlanId: 'plan_1', recoveryRunId: 'rec_1',
  })
  assert.match(error?.message || '', /must be APPROVED/)
  assert.equal(net.requests.filter((r) => r.path === '/story-jobs').length, 1, 'not three job attempts')
  assert.equal(db.rows.get('drama_1').failureCode, 'story_plan_state_invalid')
})

function finishedEpisode(extra = {}) {
  return {
    id: 'drama_1', hnId: '42', mode: 'podcast', status: 'ready', title: 'Story 42',
    url: 'https://news.ycombinator.com/item?id=42', artifactId: 'artifact_1',
    audioUrl: 'https://files.example/drama_1.mp3', progress: [], createdAt: '2026-09-29T00:00:00.000Z', ...extra,
  }
}

test('publish-only under the standing approval publishes with no confirmation claim and never re-finalizes', async (t) => {
  const db = fakeD1({
    episodes: [finishedEpisode()],
    settings: { publishingSeriesId: SERIES, [PUBLISH_BLOCKED_ALERT_KEY]: { sentAt: '2026-09-28T00:00:00.000Z' } },
  })
  const net = fakeNetwork(t, (request) => {
    if (request.path === `/publishing-series/${SERIES}`) return [200, { series: GRANTED_SERIES }]
    if (request.path === `/publishing-series/${SERIES}/releases?limit=100`) return [200, { releases: [], nextCursor: null }]
    if (request.path === `/publishing-series/${SERIES}/releases`) return [200, { release: { id: 'release_1' } }]
    if (request.path === '/publishing-releases/release_1/description/generate') return [200, {}]
    if (request.path === '/publishing-releases/release_1/publish') return [200, { release: { id: 'release_1', status: 'published' } }]
    throw new Error(`unexpected ${request.method} ${request.path}`)
  })

  const { error } = await runPipeline(envFor(db), {
    dramaId: 'drama_1', url: 'https://news.ycombinator.com/item?id=42', publishOnly: true, publishRunId: 'pub_1',
  })

  assert.equal(error, null)
  assert.deepEqual(net.requests.map((r) => `${r.method} ${r.path}`), [
    `GET /publishing-series/${SERIES}`,
    `GET /publishing-series/${SERIES}/releases?limit=100`,
    `POST /publishing-series/${SERIES}/releases`,
    'POST /publishing-releases/release_1/description/generate',
    'POST /publishing-releases/release_1/publish',
  ], 'the publish step alone: no post-production, no finalize')
  const publish = net.requests.at(-1)
  assert.deepEqual(publish.body, {}, 'no userConfirmed: the grant is the approval')
  const grantScope = `g${Date.parse('2026-09-29T00:00:00.000Z').toString(36)}`
  assert.equal(net.requests[2].key, `drama_1-publish-${grantScope}-release`)
  // No season: the platform files the release in its episode's (the month the
  // thread was posted). A hard-coded 1 put every new episode in Season 1.
  assert.equal('seasonNumber' in net.requests[2].body, false)
  assert.equal(net.requests[2].body.sourceArtifactId, 'artifact_1')
  const drama = db.rows.get('drama_1')
  assert.equal(drama.status, 'ready')
  assert.equal(drama.publishState, 'published')
  assert.equal(drama.releaseId, 'release_1')
  assert.ok(drama.progress.some((p) => p.message === PUBLISHED_PROGRESS_MESSAGE))
  assert.equal(db.store.get(PUBLISH_BLOCKED_ALERT_KEY), null, 'a successful publish re-arms the blocked-feed alert')
})

test('without a standing approval nothing is created, the episode stays ready, and the operator is told once', async (t) => {
  const db = fakeD1({ episodes: [finishedEpisode()], settings: { publishingSeriesId: SERIES } })
  const net = fakeNetwork(t, (request) => {
    if (request.path === `/publishing-series/${SERIES}`) return [200, { series: { id: SERIES } }]
    throw new Error(`unexpected ${request.method} ${request.path}`)
  })
  const env = envFor(db, { RESEND_API_KEY: 'resend_test', ALERT_EMAIL: 'ops@example.com' })

  await runPipeline(env, { dramaId: 'drama_1', url: 'https://news.ycombinator.com/item?id=42', publishOnly: true, publishRunId: 'pub_1' })
  await runPipeline(env, { dramaId: 'drama_1', url: 'https://news.ycombinator.com/item?id=42', publishOnly: true, publishRunId: 'pub_2' })

  assert.equal(net.requests.some((r) => r.path.includes('/releases')), false, 'no release is created without the grant')
  const drama = db.rows.get('drama_1')
  assert.equal(drama.status, 'ready', 'never failed: failed episodes vanish from hnradio.net')
  assert.equal(drama.publishState, 'blocked')
  assert.equal(drama.publishFailureCode, 'standing_approval_unavailable')
  assert.equal(net.emails.length, 1, 'one email per outage, not one per attempt')
  assert.match(net.emails[0].subject, /cannot reach the podcast feed/)
})

test('a feed refusal under the grant is recorded with its code, not swallowed', async (t) => {
  const db = fakeD1({ episodes: [finishedEpisode()], settings: { publishingSeriesId: SERIES } })
  fakeNetwork(t, (request) => {
    if (request.path === `/publishing-series/${SERIES}`) return [200, { series: GRANTED_SERIES }]
    if (request.path === `/publishing-series/${SERIES}/releases?limit=100`) return [200, { releases: [], nextCursor: null }]
    if (request.path === `/publishing-series/${SERIES}/releases`) return [200, { release: { id: 'release_1' } }]
    if (request.path === '/publishing-releases/release_1/description/generate') return [200, {}]
    if (request.path === '/publishing-releases/release_1/publish') {
      return refusal(400, 'validation_failed', '`userConfirmed: true` is required after the user explicitly approves publishing this release.')
    }
    throw new Error(`unexpected ${request.method} ${request.path}`)
  })

  const { error } = await runPipeline(envFor(db), {
    dramaId: 'drama_1', url: 'https://news.ycombinator.com/item?id=42', publishOnly: true, publishRunId: 'pub_1',
  })

  assert.equal(error, null)
  const drama = db.rows.get('drama_1')
  assert.equal(drama.status, 'ready')
  assert.equal(drama.publishState, 'blocked')
  assert.equal(drama.publishFailureCode, 'validation_failed')
  assert.match(drama.publishError, /userConfirmed/)
  assert.ok(drama.progress.some((p) => /Podcast publish blocked/.test(p.message)))
})

test('a lost "published" note never publishes twice: the release already on the feed is recorded', async (t) => {
  const db = fakeD1({ episodes: [finishedEpisode()], settings: { publishingSeriesId: SERIES } })
  const net = fakeNetwork(t, (request) => {
    if (request.path === `/publishing-series/${SERIES}`) return [200, { series: GRANTED_SERIES }]
    if (request.path === `/publishing-series/${SERIES}/releases?limit=100`) {
      return [200, { releases: [{ id: 'release_live', sourceArtifactId: 'artifact_1', status: 'published', createdAt: GRANTED_AT }], nextCursor: null }]
    }
    throw new Error(`unexpected ${request.method} ${request.path}`)
  })

  const { error } = await runPipeline(envFor(db), {
    dramaId: 'drama_1', url: 'https://news.ycombinator.com/item?id=42', publishOnly: true, publishRunId: 'pub_1',
  })

  assert.equal(error, null)
  assert.equal(net.requests.some((r) => r.method === 'POST'), false, 'no second release, no second publish')
  const drama = db.rows.get('drama_1')
  assert.equal(drama.publishState, 'published')
  assert.equal(drama.releaseId, 'release_live')
  assert.ok(drama.progress.some((p) => p.message === PUBLISHED_PROGRESS_MESSAGE))
})

// ── A dropped episode never airs (owner, 2026-10-04) ─────────────────────────────────────────────────

function droppedEpisode() {
  return {
    ...newEpisode('drama_dropped'),
    status: 'dropped',
    artifactId: 'artifact_dropped',
    jobId: 'job_dropped',
    audioUrl: 'https://files.example/rendered-before-the-drop.mp3',
    dropped: { at: '2026-10-04T19:51:08.895Z', by: 'owner', reason: 'A death thread: never covered.' },
  }
}

test('no Workflow makes, finalizes or publishes anything for a dropped episode, whatever started it', async (t) => {
  const net = fakeNetwork(t, () => { throw new Error('a dropped episode must make no Story API call') })
  const payloads = [
    { dramaId: 'drama_dropped', url: 'https://news.ycombinator.com/item?id=42' },
    { dramaId: 'drama_dropped', url: 'https://news.ycombinator.com/item?id=42', resumeArtifactId: 'artifact_dropped', resumeRunId: 'resume_1', skipPublish: false },
    { dramaId: 'drama_dropped', url: 'https://news.ycombinator.com/item?id=42', repairArtifactId: 'artifact_dropped', repairRunId: 'repair_1' },
    { dramaId: 'drama_dropped', url: 'https://news.ycombinator.com/item?id=42', publishOnly: true, publishRunId: 'publish_1' },
    { dramaId: 'drama_dropped', url: 'https://news.ycombinator.com/item?id=42', resumeJobId: 'job_dropped', recoveryRunId: 'recovery_1' },
  ]
  for (const payload of payloads) {
    const db = fakeD1({ episodes: [droppedEpisode()], settings: { pinnedVoices: PINNED, publishingSeriesId: SERIES } })
    const step = cloudflareStep()
    const outcome = await new HnrPipeline({}, envFor(db)).run({ payload, instanceId: 'run_dropped' }, step)
    assert.equal(outcome, 'dropped', JSON.stringify(payload))
    assert.deepEqual(step.labels, [], 'no step ran')
    assert.deepEqual(db.rows.get('drama_dropped'), droppedEpisode(), 'the row is untouched')
  }
  assert.deepEqual(net.requests, [])
})

test('an episode dropped during the pre-publish break never reaches the feed', async (t) => {
  const net = fakeNetwork(t, underGrant(() => { throw new Error('nothing may be published') }))
  const db = fakeD1({ episodes: [droppedEpisode()], settings: { publishingSeriesId: SERIES } })
  const pipeline = new HnrPipeline({}, envFor(db))
  const step = cloudflareStep()
  const outcome = await pipeline.publishToFeed(step, {
    env: envFor(db), db, sh: null, dramaId: 'drama_dropped', note: async () => {},
    artifactId: 'artifact_dropped', title: 'Story 42', payload: {},
  })
  assert.equal(outcome, 'dropped')
  assert.deepEqual(net.requests, [])
  assert.equal(db.rows.get('drama_dropped').publishState, undefined)
  assert.equal(db.rows.get('drama_dropped').releaseId, undefined)
})
