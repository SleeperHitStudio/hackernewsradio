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
const { communityGenerationRefusal, startGeneration } = await import('../worker/index.mjs')

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
    storyText: 'Self post.', author: 'submitter', comments, total: comments.length, points: 10,
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
