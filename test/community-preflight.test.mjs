import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

// worker/index.mjs re-exports the Workflow, which imports `cloudflare:workers`.
const workersStub = 'data:text/javascript,' + encodeURIComponent(
  'export class WorkflowEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env } }',
)
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') return { url: ${JSON.stringify(workersStub)}, shortCircuit: true }
  return next(specifier, context)
}`))
const { default: worker, communityGenerationRefusal, startGeneration } = await import('../worker/index.mjs')

function fakeDb({ episodes = [], settings = {} } = {}) {
  const rows = [...episodes]
  return {
    rows,
    prepare(sql) {
      const q = sql.replace(/\s+/g, ' ').trim()
      return {
        bind(...values) {
          return {
            async first() {
              if (q.startsWith('SELECT value FROM settings')) {
                return values[0] in settings ? { value: JSON.stringify(settings[values[0]]) } : null
              }
              if (q.startsWith('SELECT data FROM episodes WHERE hn_id')) {
                const row = rows.find((episode) => String(episode.hnId) === values[0])
                return row ? { data: JSON.stringify(row) } : null
              }
              if (q.startsWith('SELECT data FROM episodes WHERE id')) {
                const row = rows.find((episode) => episode.id === values[0])
                return row ? { data: JSON.stringify(row) } : null
              }
              throw new Error(`Unexpected D1 read: ${q}`)
            },
            async run() {
              if (q.startsWith('INSERT INTO episodes')) {
                rows.push(JSON.parse(values[6]))
                return { meta: { changes: 1 } }
              }
              throw new Error(`Unexpected D1 write: ${q}`)
            },
          }
        },
      }
    },
  }
}

function completeThread(id = '42') {
  const comments = Array.from({ length: 12 }, (_, index) => ({
    id: `${id}${index + 1}`, parentId: null, branch: `${id}${index + 1}`, author: `user${index}`, depth: 0, text: `Comment ${index + 1}`,
  }))
  return {
    id, title: `Story ${id}`, url: `https://news.ycombinator.com/item?id=${id}`, articleUrl: null,
    storyText: 'Self post.', author: 'submitter', pseudonymized: true, comments, total: comments.length, points: 10,
    completeness: { comments: { complete: true, expected: comments.length, fetched: comments.length, capturedAt: '2026-09-29T00:00:00.000Z' } },
  }
}

function envWith(db) {
  const creates = []
  return {
    creates,
    env: {
      DB: db,
      PIPELINE: { async create(options) { creates.push(options); return { id: options.id } } },
    },
  }
}

const READY = { checked: true, ready: true, publishing: { state: 'granted', code: null, reason: null } }

test('a visitor\'s episode is refused, before anything is claimed or queued, while the grant is missing', async () => {
  const { env, creates } = envWith(fakeDb({ settings: { publishingSeriesId: 'series_hnr' } }))
  const reads = []
  await assert.rejects(
    startGeneration({}, env, 'https://news.ycombinator.com/item?id=42', {
      requireEntitlement: false,
      deps: {
        fetchThread: async () => completeThread('42'),
        readReadiness: async (_env, options) => {
          reads.push(options)
          return { ...READY, publishing: { state: 'blocked', code: 'standing_approval_missing', reason: 'revoked' } }
        },
      },
    }),
    (error) => error.code === 'show_not_ready' && error.status === 503 && error.reason === 'approval_missing',
  )
  assert.deepEqual(reads, [{ seriesId: 'series_hnr' }])
  assert.equal(creates.length, 0, 'no Workflow: nothing is uploaded, planned or approved')
  assert.equal(env.DB.rows.length, 0, 'no episode row')
})

test('a visitor\'s episode is refused while the project, the cast or the balance is not ready', async () => {
  for (const failureClass of ['project_not_ready', 'cast_not_ready', 'quota', 'access']) {
    const refusal = await communityGenerationRefusal({ DB: fakeDb() }, {
      readReadiness: async () => ({ checked: true, ready: false, failureClass }),
    })
    assert.equal(refusal.code, 'show_not_ready', failureClass)
    assert.equal(refusal.reason, failureClass)
    assert.doesNotMatch(refusal.error, /credit|approval|key|canon/i, 'the visitor sees no internals')
  }
  const unread = await communityGenerationRefusal({ DB: fakeDb() }, { readReadiness: async () => ({ checked: false }) })
  assert.equal(unread.code, 'show_readiness_unavailable')
  const unconfigured = await communityGenerationRefusal({ DB: fakeDb() }, { readReadiness: async () => null })
  assert.equal(unconfigured.code, 'show_readiness_unavailable')
})

test('a ready show queues the visitor\'s episode, and an existing episode is reused without a read', async () => {
  const { env, creates } = envWith(fakeDb({ settings: { publishingSeriesId: 'series_hnr' } }))
  const result = await startGeneration({}, env, 'https://news.ycombinator.com/item?id=42', {
    requireEntitlement: false,
    deps: { fetchThread: async () => completeThread('42'), readReadiness: async () => READY },
  })
  assert.equal(result.reused, false)
  assert.equal(creates.length, 1)

  let reads = 0
  const again = await startGeneration({}, env, 'https://news.ycombinator.com/item?id=42', {
    requireEntitlement: false,
    deps: { fetchThread: async () => completeThread('42'), readReadiness: async () => { reads++; return READY } },
  })
  assert.equal(again.reused, true)
  assert.equal(reads, 0, 'reusing an episode spends nothing, so it needs no preflight')
})

test('a visitor\'s preflight pushes HNR\'s pinned voices into the cast canon before it judges the cast, like the nightly', async (t) => {
  const API = 'https://api.visitor.test'
  const PROJECT = 'project_hnr'
  const HOSTS = ['GARY', 'MAEVE', 'OBI', 'GRUNER']
  const pinnedVoices = Object.fromEntries(HOSTS.map((name) => [name, { voiceId: `v_${name.toLowerCase()}`, provider: 'elevenlabs' }]))
  let canon = { content: { characters: HOSTS.map((name) => ({ name, avatarUrl: `https://hnradio.net/avatars/${name.toLowerCase()}.png` })) } }
  const requests = []
  const realFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = realFetch })
  const respond = (payload) => ({ ok: true, status: 200, text: async () => JSON.stringify(payload) })
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || 'GET'
    const path = String(url).replace(`${API}/api/v1`, '')
    const body = options.body ? JSON.parse(options.body) : undefined
    requests.push({ method, path, body })
    if (path === `/story-projects/${PROJECT}` && method === 'GET') {
      const unvoiced = HOSTS.filter((name) => !canon.content.characters.find((c) => c.name === name)?.voiceId)
      return respond({
        project: {
          id: PROJECT,
          workspaceGate: { ready: true, stage: 'ready', canPlan: true, canStartEpisode: true },
          tableReadReadiness: {
            ready: unvoiced.length === 0,
            members: HOSTS.map((name) => ({ name, ready: !unvoiced.includes(name), missing: unvoiced.includes(name) ? ['voice'] : [] })),
          },
        },
      })
    }
    if (path === '/credits') return respond({ credits: { balance: 500 } })
    if (path === '/publishing-series/series_hnr') {
      return respond({ series: { id: 'series_hnr', status: 'active', medium: 'audio', standingApproval: { keyId: 'key_hnr', grantedAt: '2026-09-29T00:00:00.000Z' } } })
    }
    if (path === `/story-projects/${PROJECT}/cast-canon` && method === 'GET') return respond({ canon })
    if (path === `/story-projects/${PROJECT}/cast-canon` && method === 'PATCH') {
      canon = { content: { characters: canon.content.characters.map((c) => ({ ...c, ...body.content.characters.find((p) => p.name === c.name) })) } }
      return respond({ canon })
    }
    throw new Error(`unexpected ${method} ${path}`)
  }
  const env = {
    DB: fakeDb({ settings: { publishingSeriesId: 'series_hnr', pinnedVoices } }),
    SLEEPERHIT_API_BASE: API,
    SLEEPERHIT_API_KEY: 'sh_test_key',
    SLEEPERHIT_API_KEY_ID: 'key_hnr',
    HNRADIO_PROJECT_ID: PROJECT,
  }

  // The default readiness read, as POST /api/generate makes it.
  assert.equal(await communityGenerationRefusal(env), null, 'the healed show takes the visitor\'s episode')
  const patches = requests.filter((request) => request.method === 'PATCH')
  assert.equal(patches.length, 1)
  assert.deepEqual(patches[0].body.content.characters.map((c) => [c.name, c.voiceId]), HOSTS.map((name) => [name, `v_${name.toLowerCase()}`]))
  assert.equal(requests.filter((request) => request.path === `/story-projects/${PROJECT}`).length, 2, 'the project is re-read after the push')
})

// ── Death threads and dropped episodes (owner, 2026-10-04) ───────────────────────────────────────────

const DROPPED_ID = '61d7b65b-9002-4883-9140-96a008139b15'
const droppedRow = () => ({
  id: DROPPED_ID, hnId: '49949438', mode: 'podcast', status: 'dropped', title: 'Bob Cringely Has Died',
  url: 'https://news.ycombinator.com/item?id=49949438', commentCount: 36, artifactId: 'artifact_4', audioUrl: null,
  progress: [], dropped: { by: 'owner', reason: 'A death thread: never covered.' },
})

test('a visitor cannot request a death thread: refused before any read, claim, row or Workflow', async () => {
  const { env, creates } = envWith(fakeDb({ settings: { publishingSeriesId: 'series_hnr' } }))
  let reads = 0
  await assert.rejects(
    startGeneration({}, env, 'https://news.ycombinator.com/item?id=49953288', {
      requireEntitlement: false,
      deps: {
        fetchThread: async () => ({ ...completeThread('49953288'), title: 'Bill Draper has died' }),
        readReadiness: async () => { reads++; return READY },
      },
    }),
    (error) => error.code === 'death_thread' && error.status === 422,
  )
  assert.equal(reads, 0)
  assert.equal(creates.length, 0)
  assert.equal(env.DB.rows.length, 0)
})

test('a visitor\'s thread whose linked article announces a death is refused before anything is claimed or queued', async () => {
  const { env, creates } = envWith(fakeDb({ settings: { publishingSeriesId: 'series_hnr' } }))
  await assert.rejects(
    startGeneration({}, env, 'https://news.ycombinator.com/item?id=80', {
      requireEntitlement: false,
      deps: {
        fetchThread: async () => ({ ...completeThread('80'), title: 'Bill Draper', articleUrl: 'https://news.example/draper' }),
        readReadiness: async () => READY,
        hydrateArticle: async (thread) => { thread.article = { title: 'William Draper, Venture Capitalist, Dies at 98', text: 'Obituary.' } },
      },
    }),
    (error) => error.code === 'death_thread',
  )
  assert.equal(creates.length, 0)
  assert.equal(env.DB.rows.length, 0)
})

test('a dropped episode\'s thread is never made again, not even with force', async () => {
  for (const force of [false, true]) {
    const { env, creates } = envWith(fakeDb({ episodes: [{ ...droppedRow(), title: 'Story 49949438' }] }))
    await assert.rejects(
      startGeneration({}, env, 'https://news.ycombinator.com/item?id=49949438', {
        force,
        requireEntitlement: false,
        deps: { fetchThread: async () => completeThread('49949438'), readReadiness: async () => READY },
      }),
      (error) => error.code === 'episode_dropped' && error.status === 422,
    )
    assert.equal(creates.length, 0)
    assert.equal(env.DB.rows.length, 1)
  }
})

test('the site does not serve a dropped episode: no episode read, no landing page', async () => {
  const env = {
    DB: fakeDb({ episodes: [droppedRow()] }),
    ASSETS: { async fetch() { return new Response('<html><head><title>HNR</title></head><body></body></html>') } },
  }
  const one = await worker.fetch(new Request(`https://hnradio.net/api/dramas/${DROPPED_ID}`), env)
  assert.equal(one.status, 404)
  const page = await worker.fetch(new Request('https://hnradio.net/e/49949438'), env)
  assert.equal(page.status, 404)
  assert.doesNotMatch(await page.text(), /Cringely/)
})

test('a visitor\'s thread is fetched with the pseudonym key, and a publishing env without one fetches nothing', async () => {
  const { env, creates } = envWith(fakeDb({ settings: { publishingSeriesId: 'series_hnr' } }))
  const keys = []
  await startGeneration({}, { ...env, HNR_PSEUDONYM_KEY: 'hnr-test-pseudonym-key-0123456789' }, 'https://news.ycombinator.com/item?id=42', {
    requireEntitlement: false,
    deps: {
      fetchThread: async (_url, options) => { keys.push(options?.pseudonymKey); return completeThread('42') },
      readReadiness: async () => READY,
    },
  })
  assert.deepEqual(keys, ['hnr-test-pseudonym-key-0123456789'])
  assert.equal(creates.length, 1)

  const fetched = []
  const { env: publishing, creates: none } = envWith(fakeDb({ settings: { publishingSeriesId: 'series_hnr' } }))
  await assert.rejects(
    startGeneration({}, { ...publishing, SLEEPERHIT_API_KEY: 'sh_live_key' }, 'https://news.ycombinator.com/item?id=43', {
      requireEntitlement: false,
      deps: {
        fetchThread: async (url) => { fetched.push(url); return completeThread('43') },
        readReadiness: async () => READY,
      },
    }),
    (error) => error.code === 'pseudonym_key_missing',
  )
  assert.deepEqual(fetched, [], 'no thread is fetched without the key')
  assert.equal(none.length, 0, 'no Workflow')
})
