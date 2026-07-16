import test from 'node:test'
import assert from 'node:assert/strict'

import {
  PUBLISHED_PROGRESS_MESSAGE,
  centralRunContext,
  hasPublishedProgress,
  isActiveWorkflowStatus,
  isPublishedEpisode,
  nightlyBatchKey,
  reconcileNightlyBatch,
  runNightlyReconciliation,
} from '../worker/nightly.mjs'

function harness({ settings = new Map(), dramas = new Map(), topIds = [] } = {}) {
  const creates = []
  const workflowStatuses = new Map()
  const dependencies = {
    async getSetting(_db, key) { return structuredClone(settings.get(key) ?? null) },
    async setSetting(_db, key, value) { settings.set(key, structuredClone(value)) },
    async getDrama(_db, id) { return structuredClone(dramas.get(id) ?? null) },
    async findByHnIdAndMode(_db, hnId) {
      return structuredClone([...dramas.values()].find((drama) => String(drama.hnId) === String(hnId)) ?? null)
    },
    async upsertDrama(_db, drama) { dramas.set(drama.id, structuredClone(drama)); return drama },
    async patchDrama(_db, id, patch) {
      const current = dramas.get(id)
      if (!current) return null
      const next = { ...current, ...patch }
      dramas.set(id, next)
      return structuredClone(next)
    },
    async deleteDrama(_db, id) { return dramas.delete(id) ? 1 : 0 },
    async deleteOtherEpisodesOfThread() { return 0 },
    async fetchJson(url) {
      if (url.endsWith('/topstories.json')) return topIds
      const id = url.match(/item\/(\d+)\.json$/)?.[1]
      return { id: Number(id), type: 'story', descendants: 50, title: `Story ${id}` }
    },
    async fetchThread(url) {
      const id = url.match(/id=(\d+)/)?.[1]
      return {
        id,
        title: `Story ${id}`,
        url: `https://news.ycombinator.com/item?id=${id}`,
        total: 50,
        points: 100,
      }
    },
  }
  const env = {
    DB: {},
    PIPELINE: {
      async create(options) {
        creates.push(structuredClone(options))
        workflowStatuses.set(options.id, 'queued')
        return { id: options.id }
      },
      async get(id) {
        return { async status() { return { status: workflowStatuses.get(id) || 'unknown' } } }
      },
    },
  }
  return { creates, dependencies, dramas, env, settings, workflowStatuses }
}

test('nightly helpers distinguish active Workflows and feed-published episodes', () => {
  assert.equal(isActiveWorkflowStatus('Waiting'), true)
  assert.equal(isActiveWorkflowStatus('queued'), true)
  assert.equal(isActiveWorkflowStatus('complete'), false)

  const ready = {
    status: 'ready',
    audioUrl: 'episode.mp3',
    progress: [{ message: 'Done — your podcast is ready.' }],
  }
  assert.equal(hasPublishedProgress(ready), false)
  assert.equal(isPublishedEpisode(ready), false)
  ready.progress.push({ message: PUBLISHED_PROGRESS_MESSAGE })
  assert.equal(isPublishedEpisode(ready), true)

  assert.deepEqual(centralRunContext(new Date('2026-07-16T01:00:00.000Z')), {
    date: '2026-07-15',
    hour: 20,
  })
})

test('nightly selection scans past already-published stories until five slots are queued', async () => {
  const published = {
    id: 'published_1', hnId: '1', status: 'ready', audioUrl: 'one.mp3',
    progress: [{ message: PUBLISHED_PROGRESS_MESSAGE }],
  }
  const active = {
    id: 'active_2', hnId: '2', status: 'queued', audioUrl: null, progress: [],
    url: 'https://news.ycombinator.com/item?id=2', title: 'Story 2',
  }
  const h = harness({
    dramas: new Map([[published.id, published], [active.id, active]]),
    topIds: [1, 2, 3, 4, 5, 6, 7],
  })
  h.workflowStatuses.set(active.id, 'waiting')

  const [batch] = await runNightlyReconciliation(h.env, {
    now: new Date('2026-07-16T01:00:00.000Z'),
    dependencies: h.dependencies,
  })

  assert.equal(batch.items.length, 5)
  assert.deepEqual(batch.items.map((item) => item.hnId), ['2', '3', '4', '5', '6'])
  assert.equal(h.creates.length, 4)
  assert.equal(h.settings.get('dailyTopLastRun'), undefined)
})

test('a ready but unpublished terminal Workflow resumes the same artifact', async () => {
  const date = '2026-07-15'
  const drama = {
    id: 'episode_2',
    hnId: '2',
    status: 'ready',
    audioUrl: 'episode.mp3',
    artifactId: 'artifact_2',
    url: 'https://news.ycombinator.com/item?id=2',
    title: 'Story 2',
    progress: [{ message: 'Done — your podcast is ready.' }],
  }
  const batch = {
    date,
    status: 'running',
    target: 5,
    items: [{
      hnId: '2', url: drama.url, title: drama.title,
      episodeId: drama.id, workflowId: drama.id,
      attempt: 1, recoveryAttempts: 0, status: 'ready',
    }],
    errors: [],
  }
  const h = harness({
    settings: new Map([[nightlyBatchKey(date), batch]]),
    dramas: new Map([[drama.id, drama]]),
    topIds: [],
  })
  h.workflowStatuses.set(drama.id, 'complete')

  const reconciled = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })

  assert.equal(h.creates.length, 1)
  assert.equal(h.creates[0].params.dramaId, drama.id)
  assert.equal(h.creates[0].params.resumeArtifactId, drama.artifactId)
  assert.equal(reconciled.items[0].episodeId, drama.id)
  assert.equal(reconciled.items[0].recoveryAttempts, 1)
  assert.equal(reconciled.status, 'running')
})

test('a previously published slot is revalidated before batch completion', async () => {
  const date = '2026-07-15'
  const drama = {
    id: 'episode_2',
    hnId: '2',
    status: 'ready',
    audioUrl: 'episode.mp3',
    artifactId: 'artifact_2',
    url: 'https://news.ycombinator.com/item?id=2',
    title: 'Story 2',
    progress: [{ message: 'Done — your podcast is ready.' }],
  }
  const batch = {
    date,
    status: 'running',
    target: 5,
    items: [{
      hnId: '2', url: drama.url, title: drama.title,
      episodeId: drama.id, workflowId: drama.id,
      attempt: 1, recoveryAttempts: 0, status: 'published',
    }],
    errors: [],
  }
  const h = harness({
    settings: new Map([[nightlyBatchKey(date), batch]]),
    dramas: new Map([[drama.id, drama]]),
    topIds: [],
  })
  h.workflowStatuses.set(drama.id, 'complete')

  const reconciled = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })

  assert.equal(reconciled.items[0].status, 'queued')
  assert.equal(reconciled.items[0].recoveryAttempts, 1)
  assert.equal(reconciled.published, 0)
})
