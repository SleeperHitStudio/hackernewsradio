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

export const NIGHTLY_TARGET = 5
export const NIGHTLY_MAX_ATTEMPTS = 3
export const NIGHTLY_MUSIC_STALL_TIMEOUT_MS = 60 * 60 * 1000
export const NIGHTLY_MUSIC_RECOVERY_COOLDOWN_MS = 60 * 60 * 1000
export const NIGHTLY_MUSIC_RECOVERY_MAX_ACTIONS = 2
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
  // exhausted item is replaced by a lower-ranked candidate.
  return (batch?.items ?? []).filter((item) => item.status !== 'exhausted')
}

const nowIso = () => new Date().toISOString()

function dependencyNow(deps) {
  const value = deps.now?.() ?? new Date()
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date : new Date()
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

async function recoverItem(env, batch, item, drama, deps) {
  if (drama?.artifactId) {
    const recoveryAttempts = Number(item.recoveryAttempts || 0)
    if (recoveryAttempts >= NIGHTLY_MAX_ATTEMPTS) {
      item.status = 'exhausted'
      item.lastError = 'Artifact publishing recovery exhausted.'
      return
    }
    item.workflowId = await resumeArtifactWorkflow(env, drama)
    item.episodeId = drama.id
    item.recoveryAttempts = recoveryAttempts + 1
    item.status = 'queued'
    item.lastWorkflowStatus = 'queued'
    item.updatedAt = nowIso()
    return
  }

  const attempt = Number(item.attempt || 1)
  if (attempt >= NIGHTLY_MAX_ATTEMPTS) {
    item.status = 'exhausted'
    item.lastError = 'Generation attempts exhausted.'
    return
  }

  const thread = await deps.fetchThread(item.url)
  const replacement = await createEpisodeWorkflow(env, thread, {
    batchDate: batch.date,
    attempt: attempt + 1,
  }, deps)
  const oldEpisodeId = item.episodeId
  item.episodeId = replacement.drama.id
  item.workflowId = replacement.workflowId
  item.attempt = attempt + 1
  item.status = 'queued'
  item.lastWorkflowStatus = 'queued'
  item.updatedAt = nowIso()
  await deps.deleteOtherEpisodesOfThread(env.DB, thread.id, 'podcast', replacement.drama.id).catch(() => {})
  if (oldEpisodeId && oldEpisodeId !== replacement.drama.id) {
    // The created_at guard above normally removes it; this is only a no-op
    // cleanup for a row whose timestamp was malformed or absent.
    const old = await deps.getDrama(env.DB, oldEpisodeId)
    if (old?.status === 'failed') await deps.deleteDrama(env.DB, oldEpisodeId).catch(() => {})
  }
}

async function reconcileItem(env, batch, item, deps) {
  if (item.status === 'exhausted') return
  const drama = item.episodeId ? await deps.getDrama(env.DB, item.episodeId) : null
  if (isPublishedEpisode(drama)) {
    item.status = 'published'
    item.lastWorkflowStatus = 'complete'
    item.updatedAt = nowIso()
    return
  }

  if (drama?.status === 'failed') {
    await recoverItem(env, batch, item, drama, deps)
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
  await recoverItem(env, batch, item, drama, deps)
}

async function topStories(deps) {
  const ids = await deps.fetchJson('https://hacker-news.firebaseio.com/v0/topstories.json')
  if (!Array.isArray(ids)) throw new Error('Hacker News topstories response was not an array.')
  return ids.slice(0, 100)
}

async function fillBatch(env, batch, deps) {
  if (activeBatchItems(batch).length >= NIGHTLY_TARGET) return
  const attempted = new Set((batch.items ?? []).map((item) => String(item.hnId)))
  const seenThisPass = new Set()
  for (const id of await topStories(deps)) {
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
        const thread = await deps.fetchThread(`https://news.ycombinator.com/item?id=${hnId}`)
        const slot = activeBatchItems(batch).length
        const created = await createEpisodeWorkflow(env, thread, {
          batchDate: batch.date,
          attempt: 1,
          staggerSec: slot * 600,
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
        await reconcileItem(env, batch, item, deps)
      }
    } catch (error) {
      recordBatchError(batch, `HN ${hnId}: ${error?.message || error}`)
      await persistBatch(env.DB, batch, deps)
    }
  }
}

export async function reconcileNightlyBatch(env, date, { dependencies = {} } = {}) {
  const deps = { ...defaultDependencies, ...dependencies }
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

  for (const item of batch.items) {
    try {
      await reconcileItem(env, batch, item, deps)
    } catch (error) {
      item.lastError = error?.message || String(error)
      item.updatedAt = nowIso()
      recordBatchError(batch, `HN ${item.hnId}: ${item.lastError}`)
    }
    await persistBatch(env.DB, batch, deps)
  }

  try {
    await fillBatch(env, batch, deps)
  } catch (error) {
    recordBatchError(batch, error?.message || error)
  }

  const published = batch.items.filter((item) => item.status === 'published').length
  batch.published = published
  batch.status = published >= NIGHTLY_TARGET ? 'complete' : 'running'
  if (batch.status === 'complete') {
    batch.completedAt = nowIso()
    await deps.setSetting(env.DB, 'dailyTopLastRun', date)
  }
  await persistBatch(env.DB, batch, deps)
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

  const stillPending = []
  const batches = []
  for (const batchDate of pendingDates) {
    try {
      const batch = await reconcileNightlyBatch(env, batchDate, { dependencies: deps })
      batches.push(batch)
      if (batch.status !== 'complete') stillPending.push(batchDate)
    } catch {
      // Keep the date pending so the next hourly cron retries reconciliation.
      stillPending.push(batchDate)
    }
  }
  await deps.setSetting(env.DB, 'dailyTopPendingDates', stillPending)
  return batches
}
