import { fetchThread } from './hn.mjs'
import {
  appendProgress,
  deleteDrama,
  deleteOtherEpisodesOfThread,
  findByHnIdAndMode,
  getDrama,
  getSetting,
  patchDrama,
  setSetting,
  upsertDrama,
} from './store.mjs'
import {
  CONTRACT_CLASS_RE,
  PROVIDER_BLOCK_RE,
  QUOTA_CLASS_RE,
  classifySystemicFailure,
  isContractClassFailure,
  isProviderBlockedFailure,
  isQuotaClassFailure,
} from './failure-classification.mjs'

export {
  CONTRACT_CLASS_RE,
  PROVIDER_BLOCK_RE,
  QUOTA_CLASS_RE,
  classifySystemicFailure,
  isContractClassFailure,
  isProviderBlockedFailure,
  isQuotaClassFailure,
} from './failure-classification.mjs'

export const NIGHTLY_TARGET = 5
export const NIGHTLY_MAX_ATTEMPTS = 3
export const NIGHTLY_MUSIC_STALL_TIMEOUT_MS = 60 * 60 * 1000
export const NIGHTLY_MUSIC_RECOVERY_COOLDOWN_MS = 60 * 60 * 1000
export const NIGHTLY_MUSIC_RECOVERY_MAX_ACTIONS = 2
export const NIGHTLY_SYSTEMIC_PROBE_COOLDOWN_MS = 60 * 60 * 1000
export const NIGHTLY_GENERATION_CIRCUIT_KEY = 'nightlyGenerationCircuit'
export const PUBLISHED_PROGRESS_MESSAGE = 'Published to the HNR podcast feed.'

const MUSIC_WRITE_BUDGET_CHECKPOINT = Object.freeze({
  name: 'music write budget break',
  type: 'sleep',
})

const MUSIC_WATCHDOG_RESTART_MESSAGE =
  'Watchdog: post-production stopped waking after the music budget break; restarting from that checkpoint.'
const MUSIC_WATCHDOG_RESUME_MESSAGE =
  'Watchdog: the music wake stalled again; restarting post-production on the existing performance.'

const ACTIVE_WORKFLOW_STATUSES = new Set(['queued', 'running', 'waiting', 'waitingforpause', 'paused'])

const ALERT_FROM = 'HN Radio <noreply@updates.sleeperhit.studio>'
// One full first-wave wipeout (five stories, zero published) is alertable.
export const ALERT_MIN_FAILURES = 5

const ALERT_SUBJECTS = {
  contract: 'blocked by a contract/validation error — needs a fix, retries cannot help',
  provider: 'blocked by a provider policy throttle',
  quota: 'blocked by a provider quota cliff',
  failing: 'is failing repeatedly',
}

const ALERT_FOOTERS = {
  contract: 'The platform is REJECTING our requests (schema/validation). This is deterministic. The global generation circuit is open and permits only one hourly recovery probe until a fix deploys.',
  provider: 'The configured writer/planner provider is policy-throttling requests. The global generation circuit is open and permits only one hourly recovery probe; provider failover or the reset window must clear it.',
  quota: 'A provider quota/funding cliff is blocking generation. The global generation circuit is open and permits only one hourly recovery probe; a top-up, cap reset, or provider rebind must clear it.',
  failing: 'Repeated failures with nothing published tonight. Check the episode progress logs on hnradio.net/api/dramas?includeFailed=true.',
}

/**
 * Email the operator when a batch is in distress: a contract/validation
 * rejection (immediately — deterministic, retries cannot fix it), a
 * quota-class failure (needs a top-up or rebind), or a pile-up of ordinary
 * failures with nothing published (cumulative `failureEvents`, so a full
 * first-wave wipeout alerts on the very next tick). One email per batch date
 * per distress type; the hourly cron would otherwise spam.
 */
export async function maybeSendDistressAlert(env, batch, deps) {
  if (!env.RESEND_API_KEY || !env.ALERT_EMAIL) return null

  const recentErrors = [
    ...(batch.errors ?? []).map((entry) => entry.message),
    ...(batch.items ?? []).map((item) => item.lastError),
  ].filter(Boolean)
  const contract = (batch.items ?? []).some((item) => item.contractBlockedAt)
    || recentErrors.some((message) => isContractClassFailure(message))
  const provider = (batch.items ?? []).some((item) => item.providerBlockedAt)
    || recentErrors.some((message) => isProviderBlockedFailure(message))
  const quota = (batch.items ?? []).some((item) => item.quotaBlockedAt)
    || recentErrors.some((message) => isQuotaClassFailure(message))
  const published = (batch.items ?? []).filter((item) => item.status === 'published').length

  let type = null
  if (contract) type = 'contract'
  else if (provider) type = 'provider'
  else if (quota) type = 'quota'
  else if (published === 0 && Number(batch.failureEvents || 0) >= ALERT_MIN_FAILURES) type = 'failing'
  if (!type) return null

  const sentKey = `distressAlert:${batch.date}:${type}`
  if (await deps.getSetting(env.DB, sentKey)) return null

  const lines = [
    `hnradio nightly batch ${batch.date} is in distress (${type}).`,
    `Published so far: ${published}/${batch.target ?? NIGHTLY_TARGET}.`,
    '',
    ...(batch.items ?? []).map((item) =>
      `- [${item.status}] HN ${item.hnId} "${item.title}"${item.lastError ? ` — ${item.lastError}` : ''}`),
    '',
    'Recent batch errors:',
    ...(batch.errors ?? []).slice(-5).map((entry) => `- ${entry.at}: ${entry.message}`),
    '',
    ALERT_FOOTERS[type],
  ]

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: ALERT_FROM,
        to: [env.ALERT_EMAIL],
        subject: `[hnradio] nightly ${batch.date} ${ALERT_SUBJECTS[type]}`,
        text: lines.join('\n'),
      }),
    })
    if (!res.ok) return null
    await deps.setSetting(env.DB, sentKey, nowIso())
    return type
  } catch {
    return null
  }
}

const defaultDependencies = {
  appendProgress,
  deleteDrama,
  deleteOtherEpisodesOfThread,
  findByHnIdAndMode,
  getDrama,
  getSetting,
  patchDrama,
  setSetting,
  upsertDrama,
  fetchThread,
  now: () => new Date(),
  randomUUID: () => crypto.randomUUID(),
  async fetchJson(url) {
    const response = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!response.ok) throw new Error(`Hacker News returned ${response.status} for ${url}`)
    return response.json()
  },
}

export function centralRunContext(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    hour12: false,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
  }).formatToParts(now)
  const get = (type) => parts.find((part) => part.type === type)?.value
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')),
  }
}

export const nightlyBatchKey = (date) => `dailyTopBatch:${date}`

export function isActiveWorkflowStatus(status) {
  return ACTIVE_WORKFLOW_STATUSES.has(String(status || '').toLowerCase())
}

export function hasPublishedProgress(drama) {
  return (drama?.progress ?? []).some((entry) => entry?.message === PUBLISHED_PROGRESS_MESSAGE)
}

export function isPublishedEpisode(drama) {
  return drama?.status === 'ready' && Boolean(drama?.audioUrl) && hasPublishedProgress(drama)
}

export function activeBatchItems(batch) {
  // Published items still occupy one of the five promised slots; only an
  // exhausted/superseded item is replaced by a lower-ranked candidate.
  return (batch?.items ?? []).filter(
    (item) => !['exhausted', 'superseded'].includes(item.status),
  )
}

const nowIso = () => new Date().toISOString()

function dependencyNow(deps) {
  const value = deps.now?.() ?? new Date()
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date : new Date()
}

function openCircuitValue(value) {
  return value?.state === 'open' ? value : null
}

async function loadGenerationController(env, deps) {
  const circuit = openCircuitValue(
    await deps.getSetting(env.DB, NIGHTLY_GENERATION_CIRCUIT_KEY),
  )
  return {
    circuit,
    // A successful probe closes the persisted circuit immediately, but this
    // invocation remains restricted. The following hourly tick can then refill
    // normally without a single success releasing a same-tick fan-out.
    restrictedForRun: Boolean(circuit),
    // Starting/resuming pre-artifact work is globally serialized even while
    // the circuit is closed. Existing active work and artifact recovery do not
    // consume this slot.
    generationStarted: false,
    probeStarted: false,
    probeStatusChecked: false,
    probeStillActive: false,
  }
}

async function saveGenerationCircuit(env, controller, circuit, deps) {
  controller.circuit = circuit
  controller.restrictedForRun = true
  await deps.setSetting(env.DB, NIGHTLY_GENERATION_CIRCUIT_KEY, circuit)
}

function probeMatches(circuit, item, drama) {
  if (!circuit) return false
  return (
    (circuit.probeEpisodeId && circuit.probeEpisodeId === (drama?.id || item?.episodeId))
    || (circuit.probeWorkflowId && circuit.probeWorkflowId === item?.workflowId)
  )
}

async function openGenerationCircuit(env, controller, deps, {
  batch,
  item,
  drama,
  failureClass,
  message,
}) {
  const now = dependencyNow(deps)
  const current = controller.circuit
  const failedProbe = probeMatches(current, item, drama)
  const resetProbeWindow = !current
    || failedProbe
    || !Number.isFinite(Date.parse(current.nextProbeAt))
  const circuit = {
    ...(current ?? {}),
    state: 'open',
    failureClass,
    failureMessage: String(message || 'Nightly generation is systemically blocked.'),
    openedAt: current?.openedAt ?? now.toISOString(),
    updatedAt: now.toISOString(),
    nextProbeAt: resetProbeWindow
      ? new Date(now.getTime() + NIGHTLY_SYSTEMIC_PROBE_COOLDOWN_MS).toISOString()
      : current.nextProbeAt,
    lastFailureAt: now.toISOString(),
    lastFailureBatchDate: batch.date,
    lastFailureHnId: item.hnId,
    lastFailureEpisodeId: drama?.id || item.episodeId || null,
    ...(failedProbe ? {
      lastProbeFailureAt: now.toISOString(),
      lastProbeFailureEpisodeId: drama?.id || item.episodeId || null,
    } : {}),
  }
  await saveGenerationCircuit(env, controller, circuit, deps)
  return circuit
}

async function acquireGenerationSlot(env, controller, deps, {
  batch,
  item,
}) {
  const circuit = controller.circuit
  if (!circuit) {
    if (controller.restrictedForRun || controller.generationStarted) {
      return { allowed: false, probe: false }
    }
    controller.generationStarted = true
    return { allowed: true, probe: false }
  }
  if (controller.probeStarted) return { allowed: false, probe: false }

  const now = dependencyNow(deps)
  const nextProbeMs = Date.parse(circuit.nextProbeAt)
  if (Number.isFinite(nextProbeMs) && now.getTime() < nextProbeMs) {
    return { allowed: false, probe: false }
  }
  if (!controller.probeStatusChecked && circuit.probeWorkflowId) {
    controller.probeStatusChecked = true
    try {
      const { status } = await workflowState(env, circuit.probeWorkflowId)
      controller.probeStillActive = isActiveWorkflowStatus(status)
    } catch (error) {
      // A missing/expired Workflow is not active and may be replaced by the
      // due probe. Other inspection failures are retried on the next tick.
      controller.probeStillActive = !/not found|does not exist|unknown instance/i
        .test(error?.message || String(error))
    }
  }
  if (controller.probeStillActive) return { allowed: false, probe: false }

  controller.probeStarted = true
  controller.generationStarted = true
  const reserved = {
    ...circuit,
    updatedAt: now.toISOString(),
    lastProbeAt: now.toISOString(),
    nextProbeAt: new Date(now.getTime() + NIGHTLY_SYSTEMIC_PROBE_COOLDOWN_MS).toISOString(),
    probeCount: Number(circuit.probeCount || 0) + 1,
    probeBatchDate: batch.date,
    probeHnId: item.hnId,
    probeEpisodeId: item.episodeId || null,
    probeWorkflowId: null,
  }
  await saveGenerationCircuit(env, controller, reserved, deps)
  return { allowed: true, probe: true }
}

async function recordGenerationProbe(env, controller, deps, {
  batch,
  item,
}) {
  if (!controller.circuit) return
  await saveGenerationCircuit(env, controller, {
    ...controller.circuit,
    updatedAt: dependencyNow(deps).toISOString(),
    probeBatchDate: batch.date,
    probeHnId: item.hnId,
    probeEpisodeId: item.episodeId || null,
    probeWorkflowId: item.workflowId || null,
  }, deps)
}

async function closeGenerationCircuitForProbe(env, controller, deps, item, drama) {
  if (!probeMatches(controller.circuit, item, drama)) return false
  controller.circuit = null
  controller.restrictedForRun = true
  await deps.setSetting(env.DB, NIGHTLY_GENERATION_CIRCUIT_KEY, null)
  return true
}

function latestEpisodeProgressMs(drama) {
  const timestamps = (drama?.progress ?? [])
    .map((entry) => Date.parse(entry?.at))
    .filter(Number.isFinite)
  return timestamps.length ? Math.max(...timestamps) : null
}

function isMissingWorkflowCheckpoint(error) {
  return /(?:no|could not find)[^.]*step|step[^.]*(?:not found|does not exist)|matching[^.]*step[^.]*not found/i
    .test(error?.message || String(error))
}

function watchdogStateFor(item, artifactId) {
  const current = item.musicWatchdog
  if (!current || current.artifactId !== artifactId) {
    return { artifactId, recoveryCount: 0 }
  }
  return current
}

function recordBatchError(batch, message) {
  batch.errors = [...(batch.errors ?? []), { at: nowIso(), message: String(message) }].slice(-20)
}

async function persistBatch(db, batch, deps) {
  batch.updatedAt = nowIso()
  await deps.setSetting(db, nightlyBatchKey(batch.date), batch)
}

async function workflowState(env, workflowId) {
  const instance = await env.PIPELINE.get(workflowId)
  return {
    instance,
    status: (await instance.status())?.status || 'unknown',
  }
}

async function appendWatchdogProgress(env, batch, drama, deps, message, eventKey, runId) {
  await deps.appendProgress(env.DB, drama.id, message, {
    runId: runId || `nightly:${batch.date}:music-watchdog`,
    eventKey,
  })
}

async function recoverStalledMusicWake(env, batch, item, drama, instance, deps) {
  if (!drama?.artifactId || !instance) return false

  const now = dependencyNow(deps)
  const nowMs = now.getTime()
  const watchdog = watchdogStateFor(item, drama.artifactId)
  item.musicWatchdog = watchdog
  watchdog.artifactObservedAt ??= now.toISOString()
  const lastProgressMs = latestEpisodeProgressMs(drama) ?? Date.parse(watchdog.artifactObservedAt)
  if (!Number.isFinite(lastProgressMs) || nowMs - lastProgressMs < NIGHTLY_MUSIC_STALL_TIMEOUT_MS) return false

  const lastAttemptMs = Date.parse(watchdog.lastAttemptAt)
  if (Number.isFinite(lastAttemptMs) && nowMs - lastAttemptMs < NIGHTLY_MUSIC_RECOVERY_COOLDOWN_MS) {
    return false
  }

  const recoveryCount = Number(watchdog.recoveryCount || 0)
  if (recoveryCount >= NIGHTLY_MUSIC_RECOVERY_MAX_ACTIONS) {
    watchdog.exhaustedAt ??= now.toISOString()
    item.lastError = `Music wake watchdog exhausted after ${recoveryCount} recovery actions.`
    return false
  }

  watchdog.lastAttemptAt = now.toISOString()
  watchdog.lastObservedProgressAt = new Date(lastProgressMs).toISOString()

  if (recoveryCount === 0) {
    try {
      await instance.restart({ from: MUSIC_WRITE_BUDGET_CHECKPOINT })
    } catch (error) {
      if (!isMissingWorkflowCheckpoint(error)) throw error
      // The Workflow is legitimately still upstream of the checkpoint. Record
      // the probe so the hourly cron cannot hammer restart(), but do not consume
      // a recovery action or replace the active instance.
      watchdog.lastCheckpointMissAt = now.toISOString()
      watchdog.lastCheckpointError = error?.message || String(error)
      item.updatedAt = now.toISOString()
      return false
    }

    watchdog.recoveryCount = 1
    watchdog.lastRecoveryAt = now.toISOString()
    watchdog.lastAction = 'checkpoint-restart'
    delete watchdog.lastCheckpointError
    item.lastError = null
    item.updatedAt = now.toISOString()
    await appendWatchdogProgress(
      env,
      batch,
      drama,
      deps,
      MUSIC_WATCHDOG_RESTART_MESSAGE,
      'music-watchdog-checkpoint-restart',
      item.workflowId,
    )
    return true
  }

  // A second stale interval proves that restarting the completed sleep did not
  // wake this instance. Stop it before starting a fresh resume Workflow so two
  // post-production writers can never race. Resume mode reuses the same
  // artifact, skips generation/casting spend, reruns required autotune/music,
  // and takes the normal first-publish path with stable publication keys.
  const oldWorkflowId = item.workflowId
  const resumeRunId = deps.randomUUID()
  await instance.terminate()
  const resumed = await env.PIPELINE.create({
    id: resumeRunId,
    params: {
      dramaId: drama.id,
      url: drama.url,
      resumeArtifactId: drama.artifactId,
      resumeRunId,
      skipPublish: false,
    },
  })

  item.workflowId = resumed?.id || resumeRunId
  item.episodeId = drama.id
  item.status = 'queued'
  item.lastWorkflowStatus = 'queued'
  item.lastError = null
  item.updatedAt = now.toISOString()
  watchdog.recoveryCount = recoveryCount + 1
  watchdog.lastRecoveryAt = now.toISOString()
  watchdog.lastAction = 'resume-workflow'
  watchdog.terminatedWorkflowId = oldWorkflowId
  watchdog.resumeWorkflowId = item.workflowId
  await appendWatchdogProgress(
    env,
    batch,
    drama,
    deps,
    MUSIC_WATCHDOG_RESUME_MESSAGE,
    'music-watchdog-resume-workflow',
    resumeRunId,
  )
  return true
}

async function createEpisodeWorkflow(env, thread, {
  batchDate,
  attempt,
  staggerSec = 0,
}, deps) {
  const drama = {
    id: crypto.randomUUID(),
    hnId: String(thread.id),
    mode: 'podcast',
    url: thread.url,
    title: thread.title,
    commentCount: thread.total,
    points: thread.points ?? null,
    status: 'queued',
    progress: [{
      at: nowIso(),
      message: `Fetched ${thread.total} comments`,
      runId: `nightly:${batchDate}:attempt:${attempt}`,
      eventKey: 'thread-fetched',
    }],
    audioUrl: null,
    error: null,
    createdAt: nowIso(),
    nightlyBatchDate: batchDate,
    nightlyAttempt: attempt,
  }
  await deps.upsertDrama(env.DB, drama)
  try {
    const instance = await env.PIPELINE.create({
      id: drama.id,
      params: { dramaId: drama.id, url: thread.url, staggerSec },
    })
    return {
      drama,
      workflowId: instance?.id || drama.id,
    }
  } catch (error) {
    await deps.deleteDrama(env.DB, drama.id).catch(() => {})
    throw error
  }
}

async function resumeArtifactWorkflow(env, drama) {
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
  return workflowId
}

async function resumeGenerationWorkflow(env, drama, deps) {
  const workflowId = deps.randomUUID()
  const resource = drama?.jobId
    ? { resumeJobId: drama.jobId }
    : drama?.planId
      ? { resumePlanId: drama.planId }
      : null
  if (!resource) return null
  await env.PIPELINE.create({
    id: workflowId,
    params: {
      dramaId: drama.id,
      url: drama.url,
      ...resource,
      recoveryRunId: workflowId,
    },
  })
  return workflowId
}

async function recoverItem(
  env,
  batch,
  item,
  drama,
  deps,
  generationController,
  { allowGeneration = true } = {},
) {
  const failureMessage = drama?.failureMessage || drama?.error || item.lastError
  const failureClass = ['provider', 'quota', 'contract'].includes(drama?.failureClass)
    ? drama.failureClass
    : classifySystemicFailure({
      failureCode: drama?.failureCode,
      failureMessage,
    })
  const blocked = Boolean(failureClass)
  if (failureClass === 'provider') item.providerBlockedAt = nowIso()
  if (failureClass === 'quota') item.quotaBlockedAt = nowIso()
  if (failureClass === 'contract') item.contractBlockedAt = nowIso()

  // An existing performance is already past generation. Keep its
  // post-production/publishing recovery independent from the generation
  // circuit so an MP3 can finish while writer/planner probes are restricted.
  if (drama?.artifactId) {
    const recoveryAttempts = Number(item.recoveryAttempts || 0)
    if (!blocked && recoveryAttempts >= NIGHTLY_MAX_ATTEMPTS) {
      item.status = 'exhausted'
      item.lastError = 'Artifact publishing recovery exhausted.'
      return
    }
    item.workflowId = await resumeArtifactWorkflow(env, drama)
    item.episodeId = drama.id
    item.recoveryAttempts = blocked ? recoveryAttempts : recoveryAttempts + 1
    item.status = 'queued'
    item.lastWorkflowStatus = 'queued'
    item.updatedAt = nowIso()
    return
  }

  if (blocked) {
    await openGenerationCircuit(env, generationController, deps, {
      batch,
      item,
      drama,
      failureClass,
      message: failureMessage,
    })
  }

  if (!allowGeneration) {
    item.status = 'superseded'
    item.lastWorkflowStatus = 'superseded'
    item.lastError = failureMessage
      ? `Generation superseded by a newer nightly batch. Last failure: ${failureMessage}`
      : 'Generation superseded by a newer nightly batch.'
    item.updatedAt = nowIso()
    return
  }

  const attempt = Number(item.attempt || 1)
  if (!blocked && attempt >= NIGHTLY_MAX_ATTEMPTS) {
    item.status = 'exhausted'
    item.lastError = 'Generation attempts exhausted.'
    return
  }

  const slot = await acquireGenerationSlot(env, generationController, deps, { batch, item })
  if (!slot.allowed) {
    item.status = 'blocked'
    item.lastWorkflowStatus = 'blocked'
    item.lastError = failureMessage || generationController.circuit?.failureMessage || 'Nightly generation circuit is open.'
    item.updatedAt = nowIso()
    return
  }

  const resumedWorkflowId = await resumeGenerationWorkflow(env, drama, deps)
  if (resumedWorkflowId) {
    item.episodeId = drama.id
    item.workflowId = resumedWorkflowId
    await deps.patchDrama(env.DB, drama.id, {
      status: 'queued',
      error: null,
      failureClass: null,
      failureCode: null,
      failureMessage: null,
    })
  } else {
    const thread = await deps.fetchThread(item.url)
    const replacement = await createEpisodeWorkflow(env, thread, {
      batchDate: batch.date,
      attempt: blocked ? attempt : attempt + 1,
    }, deps)
    const oldEpisodeId = item.episodeId
    item.episodeId = replacement.drama.id
    item.workflowId = replacement.workflowId
    await deps.deleteOtherEpisodesOfThread(env.DB, thread.id, 'podcast', replacement.drama.id).catch(() => {})
    if (oldEpisodeId && oldEpisodeId !== replacement.drama.id) {
      // The created_at guard above normally removes it; this is only a no-op
      // cleanup for a row whose timestamp was malformed or absent.
      const old = await deps.getDrama(env.DB, oldEpisodeId)
      if (old?.status === 'failed') await deps.deleteDrama(env.DB, oldEpisodeId).catch(() => {})
    }
  }
  item.attempt = blocked ? attempt : attempt + 1
  item.status = 'queued'
  item.lastWorkflowStatus = 'queued'
  item.lastError = null
  item.updatedAt = nowIso()
  if (slot.probe) {
    await recordGenerationProbe(env, generationController, deps, { batch, item })
  }
}

async function reconcileItem(
  env,
  batch,
  item,
  deps,
  generationController,
  { allowGeneration = true } = {},
) {
  if (['exhausted', 'superseded'].includes(item.status)) return
  const drama = item.episodeId ? await deps.getDrama(env.DB, item.episodeId) : null
  if (drama?.artifactId || isPublishedEpisode(drama)) {
    await closeGenerationCircuitForProbe(env, generationController, deps, item, drama)
  }
  if (isPublishedEpisode(drama)) {
    item.status = 'published'
    item.lastWorkflowStatus = 'complete'
    item.updatedAt = nowIso()
    return
  }

  if (drama?.status === 'failed') {
    // Cumulative across the whole night — item.lastError alone undercounts
    // (a five-story batch shows at most five concurrent errors no matter how
    // many waves have failed), which kept the 'failing' alert from ever firing.
    batch.failureEvents = Number(batch.failureEvents || 0) + 1
    await recoverItem(
      env,
      batch,
      item,
      drama,
      deps,
      generationController,
      { allowGeneration },
    )
    return
  }

  let status = 'unknown'
  let instance = null
  if (item.workflowId) {
    try {
      const state = await workflowState(env, item.workflowId)
      status = state.status
      instance = state.instance
    } catch (error) {
      const message = error?.message || String(error)
      if (!/not found|does not exist|unknown instance/i.test(message)) {
        item.lastError = `Could not inspect Workflow ${item.workflowId}: ${message}`
        item.updatedAt = nowIso()
        return
      }
      status = 'unknown'
    }
  }
  item.lastWorkflowStatus = status
  item.updatedAt = nowIso()
  if (isActiveWorkflowStatus(status)) {
    item.status = status
    await recoverStalledMusicWake(env, batch, item, drama, instance, deps)
    return
  }

  // READY is not batch-complete until the feed publish progress event exists.
  // If a Workflow ended in that gap, resume the same artifact and its stable
  // publishing idempotency keys instead of buying another performance.
  // A ready episode resuming for publish is not a failure; a dead workflow
  // on an unfinished episode is.
  if (drama?.status !== 'ready') batch.failureEvents = Number(batch.failureEvents || 0) + 1
  await recoverItem(
    env,
    batch,
    item,
    drama,
    deps,
    generationController,
    { allowGeneration },
  )
}

async function topStories(deps) {
  const ids = await deps.fetchJson('https://hacker-news.firebaseio.com/v0/topstories.json')
  if (!Array.isArray(ids)) throw new Error('Hacker News topstories response was not an array.')
  return ids.slice(0, 100)
}

async function fillBatch(env, batch, deps, generationController, { allowGeneration = true } = {}) {
  if (!allowGeneration) return
  if (activeBatchItems(batch).length >= NIGHTLY_TARGET) return
  if (generationController.restrictedForRun || generationController.circuit) return
  const attempted = new Set((batch.items ?? []).map((item) => String(item.hnId)))
  const seenThisPass = new Set()
  for (const id of await topStories(deps)) {
    if (generationController.restrictedForRun || generationController.circuit) break
    if (activeBatchItems(batch).length >= NIGHTLY_TARGET) break
    const hnId = String(id)
    if (attempted.has(hnId) || seenThisPass.has(hnId)) continue
    seenThisPass.add(hnId)

    try {
      const story = await deps.fetchJson(`https://hacker-news.firebaseio.com/v0/item/${hnId}.json`)
      if (story?.type !== 'story' || Number(story?.descendants || 0) < 10) continue
      const existing = await deps.findByHnIdAndMode(env.DB, hnId, 'podcast')
      if (isPublishedEpisode(existing)) continue

      let item
      if (existing && ['queued', 'running', 'ready', 'failed'].includes(existing.status)) {
        item = {
          hnId,
          url: existing.url || `https://news.ycombinator.com/item?id=${hnId}`,
          title: existing.title || story.title || `Hacker News #${hnId}`,
          episodeId: existing.id,
          workflowId: existing.id,
          attempt: Number(existing.nightlyAttempt || 1),
          recoveryAttempts: 0,
          status: existing.status,
          adopted: true,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        }
      } else {
        const generationSlot = await acquireGenerationSlot(
          env,
          generationController,
          deps,
          { batch, item: { hnId, episodeId: null } },
        )
        if (!generationSlot.allowed) continue
        const thread = await deps.fetchThread(`https://news.ycombinator.com/item?id=${hnId}`)
        const created = await createEpisodeWorkflow(env, thread, {
          batchDate: batch.date,
          attempt: 1,
          staggerSec: 0,
        }, deps)
        item = {
          hnId,
          url: thread.url,
          title: thread.title,
          episodeId: created.drama.id,
          workflowId: created.workflowId,
          attempt: 1,
          recoveryAttempts: 0,
          status: 'queued',
          createdAt: nowIso(),
          updatedAt: nowIso(),
        }
      }
      batch.items.push(item)
      attempted.add(hnId)
      await persistBatch(env.DB, batch, deps)
      if (existing && ['ready', 'failed'].includes(existing.status)) {
        await reconcileItem(
          env,
          batch,
          item,
          deps,
          generationController,
          { allowGeneration },
        )
      }
      if (generationController.generationStarted) break
    } catch (error) {
      recordBatchError(batch, `HN ${hnId}: ${error?.message || error}`)
      await persistBatch(env.DB, batch, deps)
    }
  }
}

export async function reconcileNightlyBatch(env, date, {
  dependencies = {},
  generationController: suppliedGenerationController = null,
  allowGeneration = true,
  supersededByDate = null,
  itemOwnerDateByKey = null,
} = {}) {
  const deps = { ...defaultDependencies, ...dependencies }
  const generationController = suppliedGenerationController
    ?? await loadGenerationController(env, deps)
  let batch = await deps.getSetting(env.DB, nightlyBatchKey(date))
  if (!batch) {
    batch = {
      date,
      status: 'running',
      target: NIGHTLY_TARGET,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      items: [],
      errors: [],
    }
    await persistBatch(env.DB, batch, deps)
  }
  if (batch.status === 'complete') return batch
  if (!allowGeneration) {
    batch.generationSupersededAt ??= nowIso()
    batch.supersededByDate ??= supersededByDate
  }

  for (const item of batch.items) {
    const ownerDates = itemOwnerDateByKey
      ? [
          item.episodeId ? itemOwnerDateByKey.get(`episode:${item.episodeId}`) : null,
          item.hnId ? itemOwnerDateByKey.get(`hn:${item.hnId}`) : null,
        ].filter(Boolean).sort()
      : []
    const ownerDate = ownerDates.at(-1)
    if (ownerDate && ownerDate !== date) {
      item.status = 'superseded'
      item.lastWorkflowStatus = 'superseded'
      item.lastError = `Superseded by newer nightly batch ${ownerDate} for the same episode.`
      item.updatedAt = nowIso()
      await persistBatch(env.DB, batch, deps)
      continue
    }
    try {
      await reconcileItem(
        env,
        batch,
        item,
        deps,
        generationController,
        { allowGeneration },
      )
    } catch (error) {
      item.lastError = error?.message || String(error)
      item.updatedAt = nowIso()
      recordBatchError(batch, `HN ${item.hnId}: ${item.lastError}`)
    }
    await persistBatch(env.DB, batch, deps)
  }

  try {
    await fillBatch(env, batch, deps, generationController, { allowGeneration })
  } catch (error) {
    recordBatchError(batch, error?.message || error)
  }

  const published = batch.items.filter((item) => item.status === 'published').length
  batch.published = published
  if (published >= NIGHTLY_TARGET) {
    batch.status = 'complete'
  } else if (!allowGeneration) {
    batch.status = batch.items.some((item) => isActiveWorkflowStatus(item.status))
      ? 'draining'
      : 'superseded'
  } else {
    batch.status = 'running'
  }
  if (batch.status === 'complete') {
    batch.completedAt = nowIso()
    await deps.setSetting(env.DB, 'dailyTopLastRun', date)
  }
  await persistBatch(env.DB, batch, deps)
  if (batch.status === 'running') {
    await maybeSendDistressAlert(env, batch, deps).catch(() => {})
  }
  return batch
}

export async function runNightlyReconciliation(env, {
  now = new Date(),
  dependencies = {},
} = {}) {
  const deps = { ...defaultDependencies, now: () => new Date(now), ...dependencies }
  const { date, hour } = centralRunContext(now)
  let pendingDates = await deps.getSetting(env.DB, 'dailyTopPendingDates')
  pendingDates = Array.isArray(pendingDates) ? pendingDates : []

  if (hour >= 19 && !pendingDates.includes(date)) {
    const existingBatch = await deps.getSetting(env.DB, nightlyBatchKey(date))
    const legacyComplete = (await deps.getSetting(env.DB, 'dailyTopLastRun')) === date && !existingBatch
    if (!legacyComplete && existingBatch?.status !== 'complete') pendingDates.push(date)
  }
  pendingDates = [...new Set(pendingDates)].sort()
  await deps.setSetting(env.DB, 'dailyTopPendingDates', pendingDates)

  // A thread can be adopted by adjacent dates while a long Workflow is still
  // running. Assign the shared episode/thread to the newest pending batch
  // before reconciling the oldest one, otherwise both dates can independently
  // resume the same artifact for post-production.
  const pendingBatches = new Map()
  const itemOwnerDateByKey = new Map()
  for (const batchDate of pendingDates) {
    const batch = await deps.getSetting(env.DB, nightlyBatchKey(batchDate))
    pendingBatches.set(batchDate, batch)
    for (const item of batch?.items ?? []) {
      if (['exhausted', 'superseded'].includes(item.status)) continue
      if (item.episodeId) itemOwnerDateByKey.set(`episode:${item.episodeId}`, batchDate)
      if (item.hnId) itemOwnerDateByKey.set(`hn:${item.hnId}`, batchDate)
    }
  }

  let generationBatchDate = null
  for (const candidateDate of [...pendingDates].reverse()) {
    const candidateBatch = pendingBatches.get(candidateDate)
    if (!candidateBatch?.generationSupersededAt) {
      generationBatchDate = candidateDate
      break
    }
  }

  const generationController = await loadGenerationController(env, deps)
  const stillPending = []
  const batches = []
  for (const batchDate of pendingDates) {
    try {
      const batch = await reconcileNightlyBatch(env, batchDate, {
        dependencies: deps,
        generationController,
        allowGeneration: batchDate === generationBatchDate,
        supersededByDate: generationBatchDate,
        itemOwnerDateByKey,
      })
      batches.push(batch)
      if (!['complete', 'superseded'].includes(batch.status)) stillPending.push(batchDate)
    } catch {
      // Keep the date pending so the next hourly cron retries reconciliation.
      stillPending.push(batchDate)
    }
  }
  await deps.setSetting(env.DB, 'dailyTopPendingDates', stillPending)
  return batches
}
