import test from 'node:test'
import assert from 'node:assert/strict'

import {
  classifySystemicFailure,
  isReadinessClass,
  isTransientSourceFailure,
} from '../worker/failure-classification.mjs'
import {
  WORKFLOW_STEP_ONCE,
  capturedSource,
  isInsufficientCredits,
  isTransientWorkflowError,
  runHardStep,
  runWorkflowStepOnce,
  storyJobKey,
  typedRefusal,
} from '../worker/reliability.mjs'
import { SCRIPT_PAGE_LIMIT, SleeperHit, SleeperHitError } from '../worker/sleeperhit.mjs'
import { sourceIdentity, threadGrewMaterially } from '../worker/hn.mjs'

// ── Classification ──────────────────────────────────────────────────────────

test('the platform\'s own balance refusal is a quota cliff, by message and by code', () => {
  // Three outages (07-29, 09-02..11, 09-22..27) went unclassified on this text.
  assert.equal(classifySystemicFailure('Not enough Studio Credits. This job needs 20 credits; you have 4.'), 'quota')
  assert.equal(classifySystemicFailure('Top up to keep generating.'), 'quota')
  assert.equal(classifySystemicFailure({ failureCode: 'insufficient_credits', failureMessage: 'opaque' }), 'quota')
})

test('a typed 409 on project state is project_not_ready, not a contract bug', () => {
  assert.equal(classifySystemicFailure({ code: 'project_precondition_failed', message: 'anything' }), 'project_not_ready')
  assert.equal(classifySystemicFailure('Pass full Series Bible coverage before starting episodes, project videos, or publishing.'), 'project_not_ready')
})

test('a table read with an unvoiced cast is cast_not_ready; the in-run voiceMap recast stays contract', () => {
  assert.equal(classifySystemicFailure({ failureCode: 'cast_precondition_failed', failureMessage: 'x' }), 'cast_not_ready')
  assert.equal(
    classifySystemicFailure('Preassigned voiceMap is missing a voice for: JOHNSMITH1840. Supply every speaking character.'),
    'contract',
  )
})

test('source lag stays a per-item hold, never a readiness class', () => {
  const lag = { failureCode: 'hn_thread_incomplete', failureMessage: 'Hacker News thread 42 is not synchronized yet.' }
  assert.equal(classifySystemicFailure(lag), null)
  assert.equal(isTransientSourceFailure(lag), true)
})

test('readiness classes are the ones a free read can probe', () => {
  assert.deepEqual(['project_not_ready', 'cast_not_ready', 'quota', 'provider', 'contract'].map(isReadinessClass),
    [true, true, true, false, false])
})

// ── 409s and the step boundary ──────────────────────────────────────────────

const conflict = (code, message) => Object.assign(new Error(message), { status: 409, code })

test('a 409 is transient only while an Idempotency-Key is still processing', () => {
  assert.equal(isTransientWorkflowError(conflict('idempotency_conflict', 'A request with this Idempotency-Key is already processing.')), true)
  assert.equal(isTransientWorkflowError(conflict('idempotency_conflict', 'This Idempotency-Key was already used with a different request body. Use a new key for a new request.')), false)
  assert.equal(isTransientWorkflowError(conflict('project_precondition_failed', 'Pass full Series Bible coverage…')), false)
  assert.equal(isTransientWorkflowError(conflict('cast_precondition_failed', 'No voiced cast')), false)
  assert.equal(isTransientWorkflowError(conflict(undefined, 'Conflict')), false)
  // The message survives a step boundary even when the code does not.
  assert.equal(isTransientWorkflowError(new Error('A request with this Idempotency-Key is already processing.')), true)
})

/** Cloudflare's step: serialized results; a thrown error comes back as message only. */
function cloudflareStep() {
  let calls = 0
  return {
    get calls() { return calls },
    async do(_label, config, fn) {
      assert.deepEqual(config, WORKFLOW_STEP_ONCE)
      let lastError
      for (let attempt = 0; attempt <= config.retries.limit; attempt++) {
        calls++
        try {
          const value = await fn()
          return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
        } catch (error) {
          lastError = error
        }
      }
      throw new Error(lastError.message)
    },
    async sleep() {},
  }
}

test('a typed refusal crosses step.do with its status, code and details, and is not retried', async () => {
  const step = cloudflareStep()
  let sent = 0
  await assert.rejects(
    runHardStep(step, 'create plan', async () => {
      sent++
      throw new SleeperHitError('Pass full Series Bible coverage before starting episodes.', {
        status: 409,
        code: 'project_precondition_failed',
        requestId: 'req_9',
        details: { stage: 'full_coverage', canStartEpisode: false },
      })
    }, { replaySafe: true }),
    (error) => {
      assert.equal(error.status, 409)
      assert.equal(error.code, 'project_precondition_failed')
      assert.equal(error.requestId, 'req_9')
      assert.deepEqual(error.details, { stage: 'full_coverage', canStartEpisode: false })
      assert.equal(classifySystemicFailure(error), 'project_not_ready')
      return true
    },
  )
  assert.equal(sent, 1, 'the refusal is answered once, not retried by the step')
})

test('a 402 keeps details.jobId across the boundary', async () => {
  await assert.rejects(
    runWorkflowStepOnce(cloudflareStep(), 'create job', async () => {
      throw new SleeperHitError('Not enough Studio Credits.', {
        status: 402, code: 'insufficient_credits', details: { required: 20, available: 3, jobId: 'job_bound' },
      })
    }),
    (error) => isInsufficientCredits(error) && error.details.jobId === 'job_bound',
  )
})

test('transient errors keep their thrown behaviour, and plain results pass through', async () => {
  const step = cloudflareStep()
  assert.deepEqual(await runWorkflowStepOnce(step, 'read', async () => ({ ok: true })), { ok: true })
  assert.equal(await runWorkflowStepOnce(step, 'nothing', async () => undefined), undefined)
  assert.equal(typedRefusal(Object.assign(new Error('Service Unavailable'), { status: 503 })), null)
  assert.equal(typedRefusal(Object.assign(new Error('slow down'), { status: 429 })), null)
  assert.equal(typedRefusal(new Error('Table read FAILED')), null, 'an uncoded error is not a refusal')
  assert.equal(typedRefusal(new SleeperHitError('Plan generation failed.', { code: 'provider_capacity_blocked' })).code,
    'provider_capacity_blocked', 'a coded terminal failure from a status read survives too')
})

test('a 402 recovery re-sends the refused key; every other job gets its own', () => {
  assert.equal(storyJobKey({ jobScope: 'd-recovery-r2', round: 1, jobRoll: 0, resumeJobKey: 'd-recovery-r1-job-r1-j0' }),
    'd-recovery-r1-job-r1-j0')
  assert.equal(storyJobKey({ jobScope: 'd-recovery-r2', round: 1, jobRoll: 1, resumeJobKey: 'd-recovery-r1-job-r1-j0' }),
    'd-recovery-r2-job-r1-j1', 'a deliberate re-roll is a new job')
  assert.equal(storyJobKey({ jobScope: 'd', round: 2, jobRoll: 0 }), 'd-job-r2-j0')
})

test('an add-source result cached by an older run still reads as a source', () => {
  assert.deepEqual(capturedSource('source_1'), { id: 'source_1', deduplicated: false, capturedComments: null })
  assert.deepEqual(capturedSource({ id: 's', deduplicated: true, capturedComments: 12 }), { id: 's', deduplicated: true, capturedComments: 12 })
  assert.deepEqual(capturedSource({ id: 's', capturedComments: null }), { id: 's', deduplicated: false, capturedComments: null })
})

// ── Client ─────────────────────────────────────────────────────────────────

test('the whole script is read in pages the platform accepts', async () => {
  const client = new SleeperHit({ baseUrl: 'https://example.test', apiKey: 'test' })
  const total = 1_203
  const entry = (index) => ({ entryIndex: index, character: 'GARY', text: `line ${index}` })
  const paths = []
  client.request = async (path) => {
    paths.push(path)
    const limit = Number(new URL(`https://x${path}`).searchParams.get('limit'))
    assert.ok(limit <= SCRIPT_PAGE_LIMIT, `limit ${limit} would be refused`)
    const params = new URL(`https://x${path}`).searchParams
    const start = params.get('scope') === 'range' ? Number(params.get('startEntry')) : 0
    const end = params.get('scope') === 'range' ? Number(params.get('endEntry')) : Math.min(total - 1, limit - 1)
    return { script: { totalEntries: total, selection: { entries: Array.from({ length: end - start + 1 }, (_, i) => entry(start + i)) } } }
  }

  const entries = await client.getScriptEntries('artifact_1')

  assert.equal(entries.length, total)
  assert.deepEqual(entries.map((e) => e.entryIndex), Array.from({ length: total }, (_, i) => i))
  assert.deepEqual(paths, [
    '/artifacts/artifact_1/script?limit=500',
    '/artifacts/artifact_1/script?scope=range&startEntry=500&endEntry=999&limit=500',
    '/artifacts/artifact_1/script?scope=range&startEntry=1000&endEntry=1202&limit=500',
  ])
})

test('a short script is one read', async () => {
  const client = new SleeperHit({ baseUrl: 'https://example.test', apiKey: 'test' })
  let calls = 0
  client.request = async () => {
    calls++
    return { script: { totalEntries: 2, selection: { entries: [{ text: 'a' }, { text: 'b' }] } } }
  }
  assert.equal((await client.getScriptEntries('artifact_1')).length, 2)
  assert.equal(calls, 1)
})

test('an API refusal carries the envelope\'s details', async (t) => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: false,
    status: 402,
    text: async () => JSON.stringify({ error: { code: 'insufficient_credits', message: 'Not enough Studio Credits.', requestId: 'r', details: { jobId: 'job_1' } } }),
  })
  t.after(() => { globalThis.fetch = realFetch })
  const client = new SleeperHit({ baseUrl: 'https://example.test', apiKey: 'test' })
  await assert.rejects(client.request('/story-jobs', { method: 'POST', body: {} }), (error) => {
    assert.equal(error.status, 402)
    assert.equal(error.code, 'insufficient_credits')
    assert.deepEqual(error.details, { jobId: 'job_1' })
    return true
  })
})

test('readiness reads and source retirement use the documented paths', async () => {
  const client = new SleeperHit({ baseUrl: 'https://example.test', apiKey: 'test' })
  const calls = []
  client.request = async (path, options = {}) => {
    calls.push([options.method || 'GET', path])
    if (path.startsWith('/story-projects/p1') && !options.method) return { project: { id: 'p1', workspaceGate: { ready: true } } }
    if (path === '/credits') return { credits: { balance: 40 } }
    if (path.startsWith('/publishing-series/')) return { series: { id: 's1' } }
    return {}
  }
  assert.equal((await client.getProject('p1')).id, 'p1')
  assert.equal((await client.getCredits()).balance, 40)
  assert.equal((await client.getPublishingSeries('s1')).id, 's1')
  await client.deleteSource('p1', 'src_1', { idempotencyKey: 'k' })
  assert.deepEqual(calls, [
    ['GET', '/story-projects/p1'],
    ['GET', '/credits'],
    ['GET', '/publishing-series/s1'],
    ['DELETE', '/story-projects/p1/sources/src_1'],
  ])
})

// ── Item identity ──────────────────────────────────────────────────────────

test('a thread\'s identity is its numeric HN id under the HNR producer', () => {
  assert.deepEqual(sourceIdentity({ id: 42 }), { producer: 'hackernewsradio', externalId: '42' })
  assert.throws(() => sourceIdentity({ id: 'abc' }), /numeric item id/)
})

test('a capture is replaced only when the thread grew materially', () => {
  assert.equal(threadGrewMaterially(20, 50), true)
  assert.equal(threadGrewMaterially(100, 115), false, '15% growth is not material')
  assert.equal(threadGrewMaterially(100, 120), true)
  assert.equal(threadGrewMaterially(10, 19), false, 'fewer than ten new comments never is')
  assert.equal(threadGrewMaterially(null, 50), false, 'an unknown capture is kept')
})

test('"top up" is matched as words, never inside another word', () => {
  assert.equal(classifySystemicFailure('Could not capture the laptop upgrade thread.'), null)
  assert.equal(classifySystemicFailure('Please top-up your balance.'), 'quota')
})
