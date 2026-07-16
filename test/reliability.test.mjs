import test from 'node:test'
import assert from 'node:assert/strict'

import {
  AUTOTUNE_CLICK_DURATION_S,
  AUTOTUNE_CLICK_LABEL,
  AUTOTUNE_CLICK_PROMPT,
  AUTOTUNE_CLICK_VOLUME,
  MIN_SPOKEN_WORDS_PER_PAGE,
  STORY_JOB_POLL_CHUNKS,
  WORKFLOW_STEP_ONCE,
  audibleMiddleSceneIndexes,
  bookendSceneIndexes,
  ensureAutotuneClickReady,
  ensureRequestedVoiceModsReady,
  hasInFlightMusicClips,
  inspectBookends,
  isSpokenTakeThin,
  isTransientWorkflowError,
  minimumSpokenWords,
  pollInWorkflowChunks,
  postProductionIdempotencyScope,
  runHardStep,
} from '../worker/reliability.mjs'

test('spoken-word floor accepts valid 56-60 word/page takes', () => {
  assert.equal(MIN_SPOKEN_WORDS_PER_PAGE, 55)
  assert.equal(minimumSpokenWords(6), 330)
  assert.equal(isSpokenTakeThin(336, 6), false)
  assert.equal(isSpokenTakeThin(360, 6), false)
  assert.equal(isSpokenTakeThin(329, 6), true)
})

test('StoryJob chunk budget exceeds one hour', () => {
  assert.ok(STORY_JOB_POLL_CHUNKS * 45 >= 60 * 60)
})

test('repair post-production keys are fresh per repair run but stable within it', () => {
  assert.equal(postProductionIdempotencyScope('drama_1'), 'drama_1')
  assert.equal(
    postProductionIdempotencyScope('drama_1', 'repair_1'),
    'drama_1-repair-repair_1'
  )
})

test('both known Workflow reset errors are transient', () => {
  assert.equal(WORKFLOW_STEP_ONCE.retries.limit, 1)
  assert.equal(isTransientWorkflowError(new Error('Too many subrequests')), true)
  assert.equal(
    isTransientWorkflowError(new Error('Durable Object reset because its code was updated')),
    true
  )
  assert.equal(isTransientWorkflowError(Object.assign(new Error('rate limited'), { status: 429 })), true)
  assert.equal(isTransientWorkflowError(new Error('Table read FAILED')), false)
})

test('hard steps retry transient errors only when replay is explicitly safe', async () => {
  const sleeps = []
  const step = {
    do: async (_name, config, fn) => {
      assert.deepEqual(config, WORKFLOW_STEP_ONCE)
      return fn()
    },
    sleep: async (...args) => sleeps.push(args),
  }
  let unsafeCalls = 0
  await assert.rejects(
    runHardStep(step, 'unsafe post', async () => {
      unsafeCalls++
      throw new Error('Durable Object reset because its code was updated')
    }),
    /Durable Object reset/
  )
  assert.equal(unsafeCalls, 1)

  let safeCalls = 0
  const result = await runHardStep(step, 'keyed post', async () => {
    safeCalls++
    if (safeCalls === 1) throw new Error('Too many subrequests')
    return 'done'
  }, { replaySafe: true })
  assert.equal(result, 'done')
  assert.equal(safeCalls, 2)
  assert.equal(sleeps.length, 1)
})

test('chunked polling treats probe and step-level resets as pending', async () => {
  let stepCalls = 0
  let probeCalls = 0
  const sleeps = []
  const step = {
    do: async (_name, config, fn) => {
      assert.deepEqual(config, WORKFLOW_STEP_ONCE)
      stepCalls++
      if (stepCalls === 1) throw new Error('Durable Object reset because its code was updated')
      return fn()
    },
    sleep: async (...args) => sleeps.push(args),
  }
  const result = await pollInWorkflowChunks(step, 'status', 4, async () => {
    probeCalls++
    if (probeCalls === 1) throw new Error('Too many subrequests')
    return 'ready'
  })
  assert.equal(result, 'ready')
  assert.equal(stepCalls, 3)
  assert.equal(probeCalls, 2)
  assert.equal(sleeps.length, 2)
})

test('bookends use scene zero and the actual last Sleeper scene', () => {
  assert.deepEqual(bookendSceneIndexes(7), { totalScenes: 7, introIndex: 0, outroIndex: 6 })
  assert.throws(() => bookendSceneIndexes(1), /two jazz bookends are required/)

  const ready = inspectBookends({
    definedClips: [
      { sceneIndex: 0, status: 'READY', soundUrl: 'intro.mp3' },
      { sceneIndex: 6, status: 'ready', soundUrl: 'outro.mp3', anchor: 'end' },
    ],
  }, { introIndex: 0, outroIndex: 6 })
  assert.equal(ready.ready, true)

  const wrongAnchor = inspectBookends({
    definedClips: [
      { sceneIndex: 0, status: 'ready', soundUrl: 'intro.mp3' },
      { sceneIndex: 6, status: 'ready', soundUrl: 'outro.mp3', anchor: 'start' },
    ],
  }, { introIndex: 0, outroIndex: 6 })
  assert.equal(wrongAnchor.ready, false)

  const missingAnchor = inspectBookends({
    definedClips: [
      { sceneIndex: 0, status: 'ready', soundUrl: 'intro.mp3' },
      { sceneIndex: 6, status: 'ready', soundUrl: 'outro.mp3' },
    ],
  }, { introIndex: 0, outroIndex: 6 })
  assert.equal(missingAnchor.ready, false)
})

test('middle-bed verification reports every audible non-bookend scene', () => {
  assert.deepEqual(audibleMiddleSceneIndexes({
    definedClips: [
      { sceneIndex: 0, disabled: false },
      { sceneIndex: 1, disabled: false },
      { sceneIndex: 2, disabled: true },
      { sceneIndex: 6, disabled: false },
    ],
  }, { introIndex: 0, outroIndex: 6 }), [1])
})

test('late baseline music work is still classified as in flight', () => {
  assert.equal(hasInFlightMusicClips({
    definedClips: [
      { sceneIndex: 0, status: 'ready' },
      { sceneIndex: 3, status: 'rendering' },
    ],
  }), true)
  assert.equal(hasInFlightMusicClips({
    definedClips: [
      { sceneIndex: 0, status: 'ready' },
      { sceneIndex: 3, status: 'ready' },
    ],
  }), false)
})

test('failed requested voice mods are retried exactly once and must all become ready', async () => {
  const requestedRanges = [{ start: 4, end: 6 }, { start: 12, end: 12 }]
  let polls = 0
  const retries = []
  const summary = await ensureRequestedVoiceModsReady({
    requestedRanges,
    poll: async () => {
      polls++
      return polls === 1
        ? { total: 2, ready: 1, pending: 0, failed: 1, failedRanges: [requestedRanges[1]] }
        : { total: 2, ready: 2, pending: 0, failed: 0, failedRanges: [] }
    },
    retryFailed: async (ranges) => retries.push(ranges),
  })
  assert.equal(summary.ready, 2)
  assert.equal(polls, 2)
  assert.deepEqual(retries, [[requestedRanges[1]]])

  let failedRetries = 0
  await assert.rejects(ensureRequestedVoiceModsReady({
    requestedRanges,
    poll: async () => ({ total: 2, ready: 1, pending: 0, failed: 1, failedRanges: [requestedRanges[1]] }),
    retryFailed: async () => { failedRetries++ },
  }), /Gruner autotune incomplete/)
  assert.equal(failedRetries, 1)
})

test('ready requested voice mods are reused without enqueueing another render', async () => {
  const requestedRanges = [{ start: 96, end: 96 }]
  let enqueues = 0
  let retries = 0
  const summary = await ensureRequestedVoiceModsReady({
    requestedRanges,
    inspect: async () => ({
      total: 1, ready: 1, pending: 0, failed: 0,
      failedRanges: [],
      statuses: [{ start: 96, end: 96, status: 'ready' }],
    }),
    enqueueMissing: async () => { enqueues++ },
    poll: async () => ({ total: 1, ready: 1, pending: 0, failed: 0, failedRanges: [] }),
    retryFailed: async () => { retries++ },
  })

  assert.equal(summary.ready, 1)
  assert.equal(enqueues, 0)
  assert.equal(retries, 0)
})

test('missing voice mods enqueue once while failed ranges use the retry path', async () => {
  const failed = { start: 4, end: 6 }
  const missing = { start: 12, end: 12 }
  const enqueues = []
  const retries = []
  let polls = 0
  const summary = await ensureRequestedVoiceModsReady({
    requestedRanges: [failed, missing],
    inspect: async () => ({
      total: 2, ready: 0, pending: 1, failed: 1,
      failedRanges: [failed],
      statuses: [
        { ...failed, status: 'failed' },
        { ...missing, status: 'missing' },
      ],
    }),
    enqueueMissing: async (ranges) => enqueues.push(ranges),
    poll: async () => {
      polls++
      return polls === 1
        ? { total: 2, ready: 1, pending: 0, failed: 1, failedRanges: [failed] }
        : { total: 2, ready: 2, pending: 0, failed: 0, failedRanges: [] }
    },
    retryFailed: async (ranges) => retries.push(ranges),
  })

  assert.equal(summary.ready, 2)
  assert.deepEqual(enqueues, [[missing]])
  assert.deepEqual(retries, [[failed]])
  assert.equal(polls, 2)
})

test('a new Gruner dial click is exactly 0.5s and must return ready audio', async () => {
  let addFields
  let updates = 0
  const result = await ensureAutotuneClickReady({
    cues: [],
    entryIndex: 17,
    addCue: async (fields) => {
      addFields = fields
      return {
        id: 'cue_new',
        ...fields,
        soundUrl: 'https://cdn.test/dial-click.mp3',
        isDraft: false,
        isDisabled: false,
      }
    },
    updateCue: async () => { updates++ },
  })

  assert.equal(result.operation, 'add')
  assert.equal(updates, 0)
  assert.deepEqual(addFields, {
    entryIndex: 17,
    label: AUTOTUNE_CLICK_LABEL,
    prompt: AUTOTUNE_CLICK_PROMPT,
    volume: AUTOTUNE_CLICK_VOLUME,
    generatedDurationS: AUTOTUNE_CLICK_DURATION_S,
    enabled: true,
  })
  assert.equal(addFields.generatedDurationS, 0.5)
})

test('repair regenerates the existing entry cue instead of adding a duplicate', async () => {
  let adds = 0
  const updates = []
  const result = await ensureAutotuneClickReady({
    cues: [{
      id: 'cue_old',
      entryIndex: 17,
      label: 'Old buzz',
      generatedDurationS: 5,
      soundUrl: null,
      isDraft: true,
    }],
    entryIndex: 17,
    addCue: async () => { adds++ },
    updateCue: async (id, fields) => {
      updates.push({ id, fields })
      return {
        id,
        ...fields,
        soundUrl: 'https://cdn.test/repaired-click.mp3',
        isDraft: false,
        isDisabled: false,
      }
    },
  })

  assert.equal(result.operation, 'update')
  assert.equal(adds, 0)
  assert.deepEqual(updates, [{
    id: 'cue_old',
    fields: {
      entryIndex: 17,
      label: AUTOTUNE_CLICK_LABEL,
      prompt: AUTOTUNE_CLICK_PROMPT,
      volume: AUTOTUNE_CLICK_VOLUME,
      generatedDurationS: 0.5,
      enabled: true,
      regenerate: true,
    },
  }])
})

test('Gruner dial click readiness fails closed for missing, draft, disabled, or wrong-duration audio', async () => {
  for (const cue of [
    undefined,
    {
      id: 'cue_draft', entryIndex: 17, generatedDurationS: 0.5,
      soundUrl: null, isDraft: true, enabled: true,
    },
    {
      id: 'cue_disabled', entryIndex: 17, generatedDurationS: 0.5,
      soundUrl: 'https://cdn.test/disabled-click.mp3', isDraft: false, isDisabled: true,
    },
    {
      id: 'cue_long', entryIndex: 17, generatedDurationS: 5,
      soundUrl: 'https://cdn.test/long-buzz.mp3', isDraft: false, enabled: true,
    },
  ]) {
    await assert.rejects(ensureAutotuneClickReady({
      cues: [],
      entryIndex: 17,
      addCue: async () => cue,
      updateCue: async () => assert.fail('update should not run'),
    }), /Gruner dial click incomplete at entry 17/)
  }
})
