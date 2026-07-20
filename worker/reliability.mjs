export const MIN_SPOKEN_WORDS_PER_PAGE = 55
export const STORY_JOB_POLL_CHUNKS = 84
export const AUTOTUNE_CLICK_DURATION_S = 0.5
export const AUTOTUNE_CLICK_LABEL = 'Dial Click'
export const AUTOTUNE_CLICK_PROMPT =
  'One clear, dry, definitive mechanical switch click. A single isolated transient with no tail.'
export const AUTOTUNE_CLICK_VOLUME = 0.42

const TRANSIENT_WORKFLOW_ERROR_RE =
  /Too many subrequests|Durable Object reset because its code was updated|network error reaching|fetch failed|connection reset|timed out/i

// The pipeline owns retry classification so a terminal Story API response is
// never retried five times by Workflows before our code can react to it. This
// also makes every callback invocation use the same explicit idempotency key.
export const WORKFLOW_STEP_ONCE = Object.freeze({
  retries: { limit: 1, delay: '1 second', backoff: 'constant' },
  timeout: '10 minutes',
})

function errorText(error) {
  const parts = []
  let current = error
  const seen = new Set()
  while (current && !seen.has(current)) {
    seen.add(current)
    parts.push(current?.message || String(current))
    current = current?.cause
  }
  return parts.join(' ')
}

export function isTransientWorkflowError(error) {
  let current = error
  const seen = new Set()
  while (current && !seen.has(current)) {
    seen.add(current)
    const status = Number(current?.status)
    if (status === 0 || status === 408 || status === 409 || status === 425 || status === 429 || status >= 500) {
      return true
    }
    current = current?.cause
  }
  return TRANSIENT_WORKFLOW_ERROR_RE.test(errorText(error))
}

export function runWorkflowStepOnce(step, label, fn) {
  return step.do(label, WORKFLOW_STEP_ONCE, fn)
}

export function minimumSpokenWords(pageTarget) {
  return Math.round(Number(pageTarget) * MIN_SPOKEN_WORDS_PER_PAGE)
}

export function isSpokenTakeThin(spokenWords, pageTarget) {
  return Number(spokenWords) < minimumSpokenWords(pageTarget)
}

const TERMINAL_STORY_JOB_FAILURE = 'terminal-story-job-failure'

/**
 * Convert StoryJob status into a Workflow-serializable polling outcome.
 *
 * Terminal failures are returned as data instead of thrown inside step.do.
 * Cloudflare can otherwise rehydrate the thrown error without its custom
 * failureCode/state fields, forcing callers to guess terminality from prose.
 */
export function storyJobPollOutcome(job) {
  const status = String(job?.status || '').toUpperCase()
  if (status === 'READY') {
    const artifact = (job?.artifacts ?? []).find((candidate) => candidate?.type === 'table_read')
      ?? (job?.artifacts ?? [])[0]
    if (artifact?.id) return artifact.id
    return {
      kind: TERMINAL_STORY_JOB_FAILURE,
      status,
      code: 'artifact_missing',
      message: 'Job finished but produced no artifact.',
    }
  }
  if (status === 'FAILED' || status === 'CANCELED') {
    return {
      kind: TERMINAL_STORY_JOB_FAILURE,
      status,
      code: job?.failureCode || null,
      message: job?.failureMessage || `Table read ${status}.`,
    }
  }
  return 'pending'
}

export function isTerminalStoryJobFailureOutcome(value) {
  return value?.kind === TERMINAL_STORY_JOB_FAILURE
}

export function shouldRollFailedStoryJob(error) {
  return error?.terminalStoryJobFailure === true
    || /\b(?:FAILED|CANCELED)\b|generation failed/i.test(errorText(error))
}

export function terminalStoryJobFallbackPlanId(error, planId) {
  if (!planId || !shouldRollFailedStoryJob(error)) return null
  return planId
}

export function storyJobIdempotencyScope(dramaId, recoveryRunId) {
  return recoveryRunId ? `${dramaId}-recovery-${recoveryRunId}` : dramaId
}

export function postProductionIdempotencyScope(dramaId, repairRunId) {
  return repairRunId ? `${dramaId}-repair-${repairRunId}` : dramaId
}

/**
 * Retry a Workflow step only when the caller explicitly guarantees replay
 * safety (normally with a deterministic Story API idempotency key). A transient
 * Durable Object failure can happen after an upstream request was accepted, so
 * replaying an unkeyed POST would risk duplicating paid/non-idempotent work.
 */
export async function runHardStep(step, label, fn, {
  replaySafe = false,
  maxTransientRetries = 3,
  cooldown = '6 minutes',
} = {}) {
  for (let retry = 0; ; retry++) {
    try {
      return await runWorkflowStepOnce(step, retry === 0 ? label : `${label} retry${retry}`, fn)
    } catch (error) {
      if (!isTransientWorkflowError(error) || !replaySafe || retry >= maxTransientRetries) throw error
      await step.sleep(`${label} transient cooldown${retry}`, cooldown)
    }
  }
}

/**
 * Run one idempotent status probe per Workflow step. Transient errors can come
 * from the probe itself or from step.do's Durable Object, so both boundaries
 * are classified as pending before the durable sleep gives the next invocation
 * a fresh subrequest budget.
 */
export async function pollInWorkflowChunks(step, label, maxChunks, probe, {
  interval = '45 seconds',
} = {}) {
  for (let chunk = 0; chunk < maxChunks; chunk++) {
    let result
    try {
      result = await runWorkflowStepOnce(step, `${label} poll#${chunk}`, async () => {
        try {
          return await probe()
        } catch (error) {
          if (isTransientWorkflowError(error)) return 'pending'
          throw error
        }
      })
    } catch (error) {
      if (!isTransientWorkflowError(error)) throw error
      result = 'pending'
    }

    if (result !== 'pending') return result
    await step.sleep(`${label} wait#${chunk}`, interval)
  }
  throw new Error(`${label} timed out.`)
}

export function bookendSceneIndexes(totalScenes) {
  const total = Number(totalScenes)
  if (!Number.isInteger(total) || total < 2) {
    throw new Error(`Sleeper returned invalid totalScenes (${totalScenes}); two jazz bookends are required.`)
  }
  return { totalScenes: total, introIndex: 0, outroIndex: total - 1 }
}

function normalizedStatus(value) {
  return String(value || '').toLowerCase()
}

export function hasInFlightMusicClips(music) {
  return (music?.definedClips ?? []).some((clip) =>
    ['pending', 'rendering'].includes(normalizedStatus(clip?.status)))
}

export function audibleMiddleSceneIndexes(music, { introIndex, outroIndex } = {}) {
  return [...new Set((music?.definedClips ?? [])
    .filter((clip) => {
      const sceneIndex = Number(clip?.sceneIndex)
      return sceneIndex !== introIndex && sceneIndex !== outroIndex && !clip?.disabled
    })
    .map((clip) => Number(clip.sceneIndex))
    .filter(Number.isInteger))]
}

/**
 * Verify both required clips. Missing placement data fails closed: publishing
 * an unverifiable outro is how a scene-start bed previously passed as an ending.
 */
export function inspectBookends(music, {
  introIndex,
  outroIndex,
  expectedUrls,
  checkAnchor = true,
} = {}) {
  const clips = Array.isArray(music?.definedClips) ? music.definedClips : []
  const intro = clips.find((clip) => Number(clip.sceneIndex) === introIndex)
  const outro = clips.find((clip) => Number(clip.sceneIndex) === outroIndex)
  const expectedIntroUrl = expectedUrls?.intro
  const expectedOutroUrl = expectedUrls?.outro
  const introReady = normalizedStatus(intro?.status) === 'ready' && !intro?.disabled && Boolean(intro?.soundUrl)
    && (!expectedIntroUrl || intro?.soundUrl === expectedIntroUrl)
  const outroReady = normalizedStatus(outro?.status) === 'ready' && !outro?.disabled && Boolean(outro?.soundUrl)
    && (!expectedOutroUrl || outro?.soundUrl === expectedOutroUrl)
  const anchor = outro?.anchor ?? outro?.placement?.anchor
  const outroAnchored = !checkAnchor || anchor === 'end'
  return {
    intro,
    outro,
    ready: Boolean(introReady && outroReady && outroAnchored),
    failed: [intro, outro].some((clip) => normalizedStatus(clip?.status) === 'failed'),
    outroAnchored,
  }
}

/**
 * Reconcile the exact requested ranges before rendering: READY and in-flight
 * records are reused, only missing ranges are initially enqueued, and failed
 * ranges are retried once after the first poll settles. The inspect/poll
 * callbacks must return summaries scoped to the requested ranges.
 */
export async function ensureRequestedVoiceModsReady({
  requestedRanges,
  inspect,
  enqueueMissing,
  poll,
  retryFailed,
}) {
  if (!requestedRanges.length) return { total: 0, ready: 0, pending: 0, failed: 0, failedRanges: [] }

  if (inspect) {
    const initial = await inspect()
    const missingRanges = (initial?.statuses ?? [])
      .filter(({ status }) => status === 'missing')
      .map(({ start, end }) => ({ start, end }))
    if (missingRanges.length) {
      if (!enqueueMissing) throw new Error('Missing Gruner autotune ranges cannot be enqueued.')
      await enqueueMissing(missingRanges)
    }
  }

  let summary = await poll(1)
  if (summary.failed > 0) {
    await retryFailed(summary.failedRanges)
    summary = await poll(2)
  }

  if (summary.ready !== requestedRanges.length || summary.pending > 0 || summary.failed > 0) {
    throw new Error(
      `Gruner autotune incomplete: ${summary.ready}/${requestedRanges.length} ready, ` +
      `${summary.pending} pending, ${summary.failed} failed.`
    )
  }
  return summary
}

/**
 * Install the physical click that announces Gruner's autotune. Sleeper allows
 * only one cue per entry, so repair/resume runs must regenerate the existing
 * cue in place. A provider failure can leave an add as a draft cue; fail closed
 * here so an episode cannot finalize without its required click.
 */
export async function ensureAutotuneClickReady({ cues, entryIndex, addCue, updateCue }) {
  const targetEntryIndex = Number(entryIndex)
  if (!Number.isInteger(targetEntryIndex) || targetEntryIndex < 0) {
    throw new Error(`Gruner dial click has invalid entry index (${entryIndex}).`)
  }

  const existing = (Array.isArray(cues) ? cues : [])
    .find((cue) => Number(cue?.entryIndex) === targetEntryIndex)
  const fields = {
    entryIndex: targetEntryIndex,
    label: AUTOTUNE_CLICK_LABEL,
    prompt: AUTOTUNE_CLICK_PROMPT,
    volume: AUTOTUNE_CLICK_VOLUME,
    generatedDurationS: AUTOTUNE_CLICK_DURATION_S,
    enabled: true,
  }
  const cue = existing
    ? await updateCue(existing.id, { ...fields, regenerate: true })
    : await addCue(fields)

  const problems = []
  if (!cue || typeof cue !== 'object') problems.push('Sleeper returned no cue')
  if (Number(cue?.entryIndex) !== targetEntryIndex) problems.push('cue entry does not match')
  if (Number(cue?.generatedDurationS) !== AUTOTUNE_CLICK_DURATION_S) {
    problems.push(`duration is not ${AUTOTUNE_CLICK_DURATION_S}s`)
  }
  if (typeof cue?.soundUrl !== 'string' || !cue.soundUrl.trim()) problems.push('audio is missing')
  if (cue?.isDraft === true) problems.push('cue is still a draft')
  if (cue?.isDisabled === true || cue?.enabled === false) problems.push('cue is disabled')
  if (problems.length) {
    throw new Error(`Gruner dial click incomplete at entry ${targetEntryIndex}: ${problems.join(', ')}.`)
  }
  return { cue, operation: existing ? 'update' : 'add' }
}
