import { fetchThread } from './hn.mjs'
import {
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
export const PUBLISHED_PROGRESS_MESSAGE = 'Published to the HNR podcast feed.'

const ACTIVE_WORKFLOW_STATUSES = new Set(['queued', 'running', 'waiting', 'waitingforpause', 'paused'])

const defaultDependencies = {
  deleteDrama,
  deleteOtherEpisodesOfThread,
  findByHnIdAndMode,
  getDrama,
  getSetting,
  patchDrama,
  setSetting,
  upsertDrama,
  fetchThread,
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

function recordBatchError(batch, message) {
  batch.errors = [...(batch.errors ?? []), { at: nowIso(), message: String(message) }].slice(-20)
}

async function persistBatch(db, batch, deps) {
  batch.updatedAt = nowIso()
  await deps.setSetting(db, nightlyBatchKey(batch.date), batch)
}

async function workflowStatus(env, workflowId) {
  const instance = await env.PIPELINE.get(workflowId)
  return (await instance.status())?.status || 'unknown'
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
  if (item.workflowId) {
    try {
      status = await workflowStatus(env, item.workflowId)
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
  const deps = { ...defaultDependencies, ...dependencies }
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
