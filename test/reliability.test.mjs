import test from 'node:test'
import assert from 'node:assert/strict'

import { classifySystemicFailure } from '../worker/failure-classification.mjs'
import { hostForCharacter } from '../worker/brief.mjs'

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
  isDefinitiveStoryJobResumeRejection,
  isSalvagedStoryJobOutcome,
  isSpokenTakeThin,
  isTerminalStoryJobFailureOutcome,
  isTransientWorkflowError,
  minimumSpokenWords,
  pollInWorkflowChunks,
  postProductionIdempotencyScope,
  resumedStoryJobArtifactId,
  runHardStep,
  shouldRollFailedStoryJob,
  shouldReuseResumedStoryJob,
  storyJobIdempotencyScope,
  storyJobPollOutcome,
  terminalStoryJobFallbackPlanId,
  shouldRecastWithoutPinnedCast,
  offCastSpeakers,
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

test('StoryJob polling preserves terminal state across the Workflow step boundary', () => {
  assert.equal(storyJobPollOutcome({ status: 'RUNNING' }), 'pending')
  assert.equal(storyJobPollOutcome({
    status: 'READY',
    artifacts: [
      { id: 'other_1', type: 'pitch_deck' },
      { id: 'artifact_1', type: 'table_read' },
    ],
  }), 'artifact_1')

  const emptyOutput = storyJobPollOutcome({
    status: 'FAILED',
    failureCode: 'artifact_generation_failed',
    failureMessage: 'Table-read script generation produced empty output.',
  })
  assert.equal(isTerminalStoryJobFailureOutcome(emptyOutput), true)
  assert.deepEqual(emptyOutput, {
    kind: 'terminal-story-job-failure',
    status: 'FAILED',
    code: 'artifact_generation_failed',
    message: 'Table-read script generation produced empty output.',
  })

  const rehydrated = Object.assign(new Error(emptyOutput.message), {
    terminalStoryJobFailure: true,
  })
  assert.equal(shouldRollFailedStoryJob(rehydrated), true)
  assert.equal(shouldRollFailedStoryJob(new Error('Network error reaching Sleeper Hit')), false)
})

test('READY StoryJobs without artifacts roll a fresh performance', () => {
  const outcome = storyJobPollOutcome({ status: 'READY', artifacts: [] })
  assert.equal(isTerminalStoryJobFailureOutcome(outcome), true)
  assert.equal(outcome.code, 'artifact_missing')
})

test('terminal StoryJobs reuse a successful checkpoint resume before rolling fresh', () => {
  assert.equal(shouldReuseResumedStoryJob({
    action: 'generation_requeued',
    job: { id: 'job_1', status: 'RESERVED' },
  }), true)
  assert.equal(shouldReuseResumedStoryJob({
    action: 'noop',
    job: { id: 'job_1', status: 'READY' },
  }), true)
  assert.equal(shouldReuseResumedStoryJob({ action: 'generation_requeued' }), true)
  assert.equal(shouldReuseResumedStoryJob({
    action: 'noop',
    job: { id: 'job_1', status: 'FAILED' },
  }), false)
  assert.equal(shouldReuseResumedStoryJob({
    action: 'noop',
    job: { id: 'job_1', status: 'CANCELED' },
  }), false)
})

test('only authoritative resume rejections permit a fresh paid StoryJob', () => {
  assert.equal(isDefinitiveStoryJobResumeRejection({ status: 400 }), true)
  assert.equal(isDefinitiveStoryJobResumeRejection({ status: 404 }), true)
  assert.equal(isDefinitiveStoryJobResumeRejection({ status: 409 }), true)
  assert.equal(isDefinitiveStoryJobResumeRejection({ status: 422 }), true)
  assert.equal(isDefinitiveStoryJobResumeRejection({ status: 408 }), false)
  assert.equal(isDefinitiveStoryJobResumeRejection({ status: 429 }), false)
  assert.equal(isDefinitiveStoryJobResumeRejection({ status: 503 }), false)
  assert.equal(isDefinitiveStoryJobResumeRejection({ status: 0 }), false)
  assert.equal(isDefinitiveStoryJobResumeRejection(new Error('network reset')), false)
})

test('terminal resumed jobs fall back to their plan under a fresh recovery scope', () => {
  const terminal = Object.assign(new Error('Table read FAILED.'), {
    terminalStoryJobFailure: true,
  })

  assert.equal(terminalStoryJobFallbackPlanId(terminal, 'plan_1'), 'plan_1')
  assert.equal(terminalStoryJobFallbackPlanId(new Error('Network error'), 'plan_1'), null)
  assert.equal(terminalStoryJobFallbackPlanId(terminal, null), null)
  assert.equal(storyJobIdempotencyScope('drama_1'), 'drama_1')
  assert.equal(
    storyJobIdempotencyScope('drama_1', 'recovery_1'),
    'drama_1-recovery-recovery_1',
  )
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

const LYRIA_QUOTA_MESSAGE =
  'Planned Lyria music clip failed: Lyria clip generation error (429) after 4 attempts: '
  + 'Your prepayment credits are depleted. Please go to AI Studio to manage your project and billing.'
const PERFORMABLE_MUSIC_MESSAGE =
  'Table read became performable, but its planned music did not complete within the audio finishing budget.'

test('a PARTIAL job whose table read is READY delivers the artifact instead of polling on', () => {
  assert.equal(
    storyJobPollOutcome({
      status: 'PARTIAL',
      artifacts: [{ id: 'art_partial', type: 'table_read', status: 'READY' }],
    }),
    'art_partial',
  )
})

test('a PARTIAL job whose table read is still running keeps polling', () => {
  assert.equal(
    storyJobPollOutcome({
      status: 'PARTIAL',
      artifacts: [{ id: 'art_partial', type: 'table_read', status: 'RUNNING' }],
    }),
    'pending',
  )
  assert.equal(storyJobPollOutcome({ status: 'PARTIAL', artifacts: [] }), 'pending')
})

test('a job that failed only on planned music yields a salvageable performance', () => {
  for (const failureMessage of [PERFORMABLE_MUSIC_MESSAGE, LYRIA_QUOTA_MESSAGE]) {
    const outcome = storyJobPollOutcome({
      status: 'FAILED',
      failureMessage,
      artifacts: [{ id: 'art_salvage', type: 'table_read', status: 'READY' }],
    })
    assert.equal(isSalvagedStoryJobOutcome(outcome), true, failureMessage)
    assert.equal(isTerminalStoryJobFailureOutcome(outcome), false, failureMessage)
    assert.equal(outcome.artifactId, 'art_salvage')
  }
})

test('a music failure with no performable read stays terminal', () => {
  const noArtifact = storyJobPollOutcome({
    status: 'FAILED',
    failureMessage: LYRIA_QUOTA_MESSAGE,
    artifacts: [],
  })
  assert.equal(isTerminalStoryJobFailureOutcome(noArtifact), true)

  const unfinishedRead = storyJobPollOutcome({
    status: 'FAILED',
    failureMessage: LYRIA_QUOTA_MESSAGE,
    artifacts: [{ id: 'art_unfinished', type: 'table_read', status: 'FAILED' }],
  })
  assert.equal(isTerminalStoryJobFailureOutcome(unfinishedRead), true)
})

test('a non-music failure is never salvaged, even with a ready artifact', () => {
  const outcome = storyJobPollOutcome({
    status: 'FAILED',
    failureMessage: 'Table-read script generation failed: Failed after 3 attempts. Last error: Service Unavailable',
    artifacts: [{ id: 'art_bad', type: 'table_read', status: 'READY' }],
  })
  assert.equal(isSalvagedStoryJobOutcome(outcome), false)
  assert.equal(isTerminalStoryJobFailureOutcome(outcome), true)
})

test('an already-complete resume hands back its performance', () => {
  assert.equal(
    resumedStoryJobArtifactId({
      action: 'already_complete',
      artifactIds: ['art_resumed'],
      job: { status: 'FAILED', artifacts: [{ id: 'art_resumed', type: 'table_read', status: 'READY' }] },
    }),
    'art_resumed',
  )
  // artifactIds alone is enough when the job body carries no usable artifact.
  assert.equal(
    resumedStoryJobArtifactId({ action: 'already_complete', artifactIds: ['art_only'], job: null }),
    'art_only',
  )
})

test('a resume that requeued work is polled, not adopted', () => {
  assert.equal(
    resumedStoryJobArtifactId({
      action: 'generation_requeued',
      artifactIds: ['art_pending'],
      job: { status: 'RUNNING' },
    }),
    null,
  )
  // An ambiguous multi-artifact response must not guess which read to adopt.
  assert.equal(
    resumedStoryJobArtifactId({ action: 'already_complete', artifactIds: ['a', 'b'], job: null }),
    null,
  )
})

function fakeStep() {
  return {
    do: async (_label, optsOrFn, maybeFn) => (typeof optsOrFn === 'function' ? optsOrFn() : maybeFn()),
    sleep: async () => {},
  }
}

test('an unreadable probe is not counted as evidence the work is unfinished', async () => {
  // The bug this closes: hnradio polled a job for 63 minutes and reported a
  // bare "timed out" — while that exact job had gone READY 33 minutes earlier.
  // Every probe had failed to read, which is indistinguishable from 'pending'.
  let calls = 0
  const probe = async () => {
    calls += 1
    if (calls <= 3) throw Object.assign(new Error('fetch failed'), { status: 0 })
    return 'artifact_1'
  }
  assert.equal(await pollInWorkflowChunks(fakeStep(), 'job r1a1', 40, probe), 'artifact_1')
  assert.equal(calls, 4)
})

test('a sustained run of unreadable probes fails with the cause, not a bare timeout', async () => {
  const probe = async () => { throw Object.assign(new Error('Service Unavailable'), { status: 503 }) }
  await assert.rejects(
    pollInWorkflowChunks(fakeStep(), 'job r1a1', 84, probe, { maxConsecutiveUnreadable: 5 }),
    (err) => {
      assert.match(err.message, /could not be read for 5 consecutive probes/)
      assert.match(err.message, /Service Unavailable/)
      return true
    },
  )
})

test('a recovered read resets the unreadable streak', async () => {
  let calls = 0
  const probe = async () => {
    calls += 1
    // Alternating failures must never accumulate into a false hard failure.
    if (calls % 2 === 1) throw Object.assign(new Error('connection reset'), { status: 0 })
    return calls >= 8 ? 'artifact_2' : 'pending'
  }
  assert.equal(await pollInWorkflowChunks(fakeStep(), 'job r1a1', 40, probe, { maxConsecutiveUnreadable: 3 }), 'artifact_2')
})

test('an ordinary timeout still reports unreadable probes it saw along the way', async () => {
  let calls = 0
  const probe = async () => {
    calls += 1
    if (calls === 2) throw Object.assign(new Error('fetch failed'), { status: 0 })
    return 'pending'
  }
  await assert.rejects(
    pollInWorkflowChunks(fakeStep(), 'job r1a1', 5, probe),
    (err) => {
      assert.match(err.message, /timed out after 5 probes \(1 unreadable/)
      return true
    },
  )
})

test('a terminal probe error is never swallowed as unreadable', async () => {
  const probe = async () => { throw new Error('Table read FAILED') }
  await assert.rejects(pollInWorkflowChunks(fakeStep(), 'job r1a1', 10, probe), /Table read FAILED/)
})

test('a guest commenter without a pinned voice is recast, not treated as systemic', () => {
  // The show reads Hacker News comments aloud, so the writer regularly hands a
  // commenter a line. The pinned map covers only the four hosts, and the
  // platform refuses the job. This is the exact message that halted a night's
  // batch at 1 of 5 episodes.
  const err = new Error(
    'Preassigned voiceMap is missing a voice for: JOHNSMITH1840. Supply every speaking character.',
  )

  // THE TRAP: it is systemic BY CLASSIFICATION and recoverable IN FACT. The
  // pipeline used to classify first, so this branch rethrew the one error it
  // exists to absorb, and the recovery was unreachable for its own trigger.
  assert.equal(classifySystemicFailure(err), 'contract')
  assert.equal(shouldRecastWithoutPinnedCast({ error: err, includePinnedCast: true, attempt: 1 }), true)
})

test('recasting is not retried once the pinned map is already dropped', () => {
  // Second time around the map is gone and the platform still refused, so it is
  // a real contract failure and must be allowed to classify as one.
  const err = new Error('Preassigned voiceMap is missing a voice for: SOMEONE. Supply every speaking character.')
  assert.equal(shouldRecastWithoutPinnedCast({ error: err, includePinnedCast: false, attempt: 1 }), false)
})

test('recasting stops at the attempt ceiling', () => {
  const err = new Error('Preassigned voiceMap is missing a voice for: SOMEONE.')
  assert.equal(shouldRecastWithoutPinnedCast({ error: err, includePinnedCast: true, attempt: 2 }), true)
  assert.equal(shouldRecastWithoutPinnedCast({ error: err, includePinnedCast: true, attempt: 3 }), false)
})

test('an unrelated failure is never mistaken for a casting problem', () => {
  for (const message of [
    'Table-read script generation produced empty output.',
    'autotune render a2 timed out.',
    'Schema validation failed — response did not match schema',
  ]) {
    assert.equal(
      shouldRecastWithoutPinnedCast({ error: new Error(message), includePinnedCast: true, attempt: 1 }),
      false,
      message,
    )
  }
})

test('a commenter given their own line is detected as off-cast', () => {
  // The exact shape that halted a batch: the writer gave an HN handle a line.
  const entries = [
    { character: 'GARY', text: 'so this thread' },
    { character: 'JOHNSMITH1840', text: 'actually, the JVM' },
    { character: 'MAEVE', text: 'nobody asked' },
  ]
  assert.deepEqual(offCastSpeakers(entries, (l) => Boolean(hostForCharacter(l))), ['JOHNSMITH1840'])
})

test('a clean four-host script has nothing off-cast', () => {
  const entries = ['GARY', 'MAEVE', 'OBI', 'GRUNER', 'GARY'].map((character) => ({ character, text: 'x' }))
  assert.deepEqual(offCastSpeakers(entries, (l) => Boolean(hostForCharacter(l))), [])
})

test('host labels with decoration still count as the host', () => {
  // hostForCharacter matches "Gary (host)" and case variants; a rename-ish
  // label must not be mistaken for a fifth voice and trigger a needless reroll.
  const entries = [
    { character: 'Gary (host)', text: 'x' },
    { character: 'maeve', text: 'x' },
    { character: 'GRUNER (dial)', text: 'x' },
  ]
  assert.deepEqual(offCastSpeakers(entries, (l) => Boolean(hostForCharacter(l))), [])
})

test('each off-cast speaker is reported once, in first-seen order', () => {
  const entries = [
    { character: 'ANNOUNCER', text: 'x' },
    { character: 'JOHNSMITH1840', text: 'x' },
    { character: 'announcer', text: 'x' },
    { character: '', text: 'x' },
    { character: 'JOHNSMITH1840', text: 'x' },
  ]
  assert.deepEqual(
    offCastSpeakers(entries, (l) => Boolean(hostForCharacter(l))),
    ['ANNOUNCER', 'JOHNSMITH1840'],
  )
})

test('an unreadable script is not treated as a cast violation', () => {
  // The measure step is best-effort and returns null on failure; a missing or
  // malformed script must never trigger a reroll on cast grounds.
  for (const value of [null, undefined, [], 'nonsense', [{ text: 'no character' }]]) {
    assert.deepEqual(offCastSpeakers(value, (l) => Boolean(hostForCharacter(l))), [], String(value))
  }
})
