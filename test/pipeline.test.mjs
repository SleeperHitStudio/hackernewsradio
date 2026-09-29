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
                rows.set(values[0], JSON.parse(values[6]))
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

function envFor(db, extra = {}) {
  return {
    DB: db,
    SLEEPERHIT_API_BASE: API,
    SLEEPERHIT_API_KEY: 'sh_test',
    HNRADIO_PROJECT_ID: PROJECT,
    ...extra,
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
  const db = fakeD1({ episodes: [newEpisode()], settings: { pinnedVoices: PINNED } })
  const net = fakeNetwork(t, (request) => {
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
  })

  const { error } = await runPipeline(envFor(db), { dramaId: 'drama_1', url: 'https://news.ycombinator.com/item?id=42' },
    cloudflareStep({ 'fetch complete thread': completeThread('42', 50) }))

  assert.ok(error, 'the refusal ends the run')

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
  assert.ok(drama.progress.some((p) => /Reusing the source already captured for HN thread 42 \(48 comments\)/.test(p.message)))
})

test('a cast canon refusal fails the episode instead of being swallowed', async (t) => {
  const db = fakeD1({ episodes: [newEpisode()], settings: { pinnedVoices: PINNED } })
  const net = fakeNetwork(t, (request) => {
    if (request.method === 'GET' && request.path.endsWith('/cast-canon')) return [200, FACES_ONLY_CANON]
    if (request.method === 'PATCH') return refusal(400, 'validation_failed', 'Invalid key in record: avatarStyle')
    throw new Error(`unexpected ${request.method} ${request.path}`)
  })

  const { error } = await runPipeline(envFor(db), { dramaId: 'drama_1', url: 'https://news.ycombinator.com/item?id=42' },
    cloudflareStep({ 'fetch complete thread': completeThread('42', 50) }))

  assert.match(error?.message || '', /Invalid key in record/)
  assert.equal(net.requests.some((r) => r.path.endsWith('/sources')), false, 'nothing is uploaded after the refusal')
  const drama = db.rows.get('drama_1')
  assert.equal(drama.status, 'failed')
  assert.equal(drama.failureClass, 'contract')
  assert.equal(drama.failureCode, 'validation_failed')
})

test('a thread that grew after a failed-before-plan attempt is recaptured: DELETE, then a fresh POST', async (t) => {
  const db = fakeD1({ episodes: [newEpisode()], settings: { pinnedVoices: PINNED } })
  let posts = 0
  const net = fakeNetwork(t, (request) => {
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
  })

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
  assert.equal(db.rows.get('drama_1').sourceId, 'source_fresh')
})

function recoveredEpisode(extra = {}) {
  return {
    id: 'drama_1', hnId: '42', mode: 'podcast', status: 'failed', title: 'Story 42',
    url: 'https://news.ycombinator.com/item?id=42', commentCount: 50, points: 100,
    planId: 'plan_1', progress: [], createdAt: '2026-09-29T00:00:00.000Z', ...extra,
  }
}

test('a 402 on the job stops the run and keeps the exact request; the recovery re-sends the SAME key and body', async (t) => {
  const db = fakeD1({ episodes: [recoveredEpisode()], settings: { pinnedVoices: PINNED } })
  const net = fakeNetwork(t, (request) => {
    if (request.path === '/story-plans/plan_1/resume') return [200, { plan: { id: 'plan_1', status: 'APPROVED' } }]
    if (request.path === '/story-plans/plan_1') return [200, { plan: { id: 'plan_1', status: 'APPROVED' } }]
    if (request.path === '/story-jobs') {
      return refusal(402, 'insufficient_credits', 'Not enough Studio Credits. This job needs 20 credits; you have 4.',
        { required: 20, available: 4, jobId: null })
    }
    throw new Error(`unexpected ${request.method} ${request.path}`)
  })

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

for (const [label, series, expected] of [
  ['under the series\' standing approval, plan approval claims no human confirmation', { id: SERIES, standingApproval: { keyId: 'key_hnr', grantedAt: '2026-09-29T00:00:00.000Z' } }, {}],
  ['without a reported grant, plan approval keeps its confirmation', { id: SERIES }, { userConfirmed: true }],
]) {
  test(label, async (t) => {
    const db = fakeD1({ episodes: [recoveredEpisode()], settings: { pinnedVoices: PINNED, publishingSeriesId: SERIES } })
    const net = fakeNetwork(t, (request) => {
      if (request.path === '/story-plans/plan_1/resume') return [200, { plan: { id: 'plan_1', status: 'REQUIRES_APPROVAL' } }]
      if (request.path === '/story-plans/plan_1') return [200, { plan: { id: 'plan_1', status: 'REQUIRES_APPROVAL' } }]
      if (request.path === `/publishing-series/${SERIES}`) return [200, { series }]
      if (request.path === '/story-plans/plan_1/approve') return [200, { plan: { id: 'plan_1', status: 'APPROVED' } }]
      if (request.path === '/story-jobs') return refusal(402, 'insufficient_credits', 'Not enough Studio Credits.')
      throw new Error(`unexpected ${request.method} ${request.path}`)
    })
    await runPipeline(envFor(db), {
      dramaId: 'drama_1', url: 'https://news.ycombinator.com/item?id=42', resumePlanId: 'plan_1', recoveryRunId: 'rec_1',
    })
    const approve = net.requests.find((r) => r.path === '/story-plans/plan_1/approve')
    assert.deepEqual(approve.body, expected)
  })
}

function finishedEpisode(extra = {}) {
  return {
    id: 'drama_1', hnId: '42', mode: 'podcast', status: 'ready', title: 'Story 42',
    url: 'https://news.ycombinator.com/item?id=42', artifactId: 'artifact_1',
    audioUrl: 'https://files.example/drama_1.mp3', progress: [], createdAt: '2026-09-29T00:00:00.000Z', ...extra,
  }
}

const GRANTED_SERIES = { id: SERIES, standingApproval: { keyId: 'key_hnr', grantedAt: '2026-09-29T00:00:00.000Z' } }

test('publish-only under the standing approval publishes with no confirmation claim and never re-finalizes', async (t) => {
  const db = fakeD1({
    episodes: [finishedEpisode()],
    settings: { publishingSeriesId: SERIES, [PUBLISH_BLOCKED_ALERT_KEY]: { sentAt: '2026-09-28T00:00:00.000Z' } },
  })
  const net = fakeNetwork(t, (request) => {
    if (request.path === `/publishing-series/${SERIES}`) return [200, { series: GRANTED_SERIES }]
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
    `POST /publishing-series/${SERIES}/releases`,
    'POST /publishing-releases/release_1/description/generate',
    'POST /publishing-releases/release_1/publish',
  ], 'the publish step alone: no post-production, no finalize')
  const publish = net.requests.at(-1)
  assert.deepEqual(publish.body, {}, 'no userConfirmed: the grant is the approval')
  const grantScope = `g${Date.parse('2026-09-29T00:00:00.000Z').toString(36)}`
  assert.equal(net.requests[1].key, `drama_1-publish-${grantScope}-release`)
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
