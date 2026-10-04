import test from 'node:test'
import assert from 'node:assert/strict'

import {
  canResumeGeneration,
  NIGHTLY_GENERATION_CIRCUIT_KEY,
  NIGHTLY_MAX_SOURCE_LAG_HOLDS,
  NIGHTLY_MUSIC_RECOVERY_COOLDOWN_MS,
  NIGHTLY_MUSIC_RECOVERY_MAX_ACTIONS,
  NIGHTLY_MUSIC_STALL_TIMEOUT_MS,
  NIGHTLY_SYSTEMIC_PROBE_COOLDOWN_MS,
  PUBLISHED_PROGRESS_MESSAGE,
  centralRunContext,
  classifySystemicFailure,
  hasPublishedProgress,
  isActiveWorkflowStatus,
  isPublishedEpisode,
  nightlyBatchKey,
  reconcileNightlyBatch,
  runNightlyReconciliation,
} from '../worker/nightly.mjs'
import {
  WORKFLOW_DEPLOY_GATE_KEY,
  activeWorkflowDeployGate,
  workflowDeployRetryAfterSeconds,
} from '../worker/deploy-gate.mjs'
import { readReadiness } from '../worker/readiness.mjs'
import { isModelOutputMissFailure } from '../worker/failure-classification.mjs'
import { SleeperHitError } from '../worker/sleeperhit.mjs'

function harness({
  settings = new Map(),
  dramas = new Map(),
  topIds = [],
  now = '2026-07-16T06:00:00.000Z',
  randomIds = ['resume_watchdog_1'],
} = {}) {
  const creates = []
  const deletes = []
  const restarts = []
  const terminations = []
  const workflowStatuses = new Map()
  const missingCheckpoints = new Set()
  const clock = { now: new Date(now) }
  const ids = [...randomIds]
  const dependencies = {
    now: () => new Date(clock.now),
    randomUUID: () => ids.shift() || `resume_watchdog_${creates.length + 1}`,
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
    async appendProgress(_db, id, message, { runId, eventKey } = {}) {
      const current = dramas.get(id)
      if (!current) return []
      const progress = [...(current.progress ?? []), {
        at: clock.now.toISOString(), message, runId, eventKey,
      }]
      dramas.set(id, { ...current, progress })
      return structuredClone(progress)
    },
    async deleteDrama(_db, id) { deletes.push({ type: 'episode', id }); return dramas.delete(id) ? 1 : 0 },
    async deleteOtherEpisodesOfThread(...args) { deletes.push({ type: 'thread', args }); return 0 },
    async fetchJson(url) {
      if (url.endsWith('/topstories.json')) return topIds
      const id = url.match(/item\/(\d+)\.json$/)?.[1]
      return { id: Number(id), type: 'story', descendants: 50, title: `Story ${id}` }
    },
    async fetchArticle() {
      throw new Error('fetchArticle must not run for a story without a linked article')
    },
    async fetchThread(url) {
      const id = url.match(/id=(\d+)/)?.[1]
      const comments = Array.from({ length: 50 }, (_, index) => ({
        id: `${id}${String(index + 1).padStart(3, '0')}`,
        parentId: null,
        branch: `${id}${String(index + 1).padStart(3, '0')}`,
        author: `user${index + 1}`,
        depth: 0,
        text: `Complete comment ${index + 1}`,
      }))
      return {
        id,
        title: `Story ${id}`,
        url: `https://news.ycombinator.com/item?id=${id}`,
        articleUrl: null,
        storyText: 'Complete self-post body.',
        author: 'submitter',
        comments,
        total: 50,
        points: 100,
        completeness: {
          comments: {
            complete: true,
            expected: 50,
            fetched: 50,
            capturedAt: '2026-07-16T06:00:00.000Z',
            metadataSource: 'official-hn-firebase',
            contentSource: 'hn-algolia-search-plus-recursive-item-tree',
          },
        },
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
        return {
          async status() { return { status: workflowStatuses.get(id) || 'unknown' } },
          async restart(options) {
            restarts.push({ id, options: structuredClone(options) })
            if (missingCheckpoints.has(id)) throw new Error('No workflow step matching the requested checkpoint was found.')
            workflowStatuses.set(id, 'waiting')
          },
          async terminate() {
            terminations.push(id)
            workflowStatuses.set(id, 'terminated')
          },
        }
      },
    },
  }
  return {
    clock,
    creates,
    deletes,
    dependencies,
    dramas,
    env,
    missingCheckpoints,
    restarts,
    settings,
    terminations,
    workflowStatuses,
  }
}

function activeArtifactFixture({
  now = '2026-07-16T06:00:00.000Z',
  progressAgeMs = NIGHTLY_MUSIC_STALL_TIMEOUT_MS + 1,
  musicWatchdog,
} = {}) {
  const date = '2026-07-15'
  const nowMs = Date.parse(now)
  const drama = {
    id: 'episode_stalled',
    hnId: '42',
    status: 'running',
    audioUrl: null,
    artifactId: 'artifact_stable',
    jobId: 'job_stable',
    url: 'https://news.ycombinator.com/item?id=42',
    title: 'Story 42',
    createdAt: '2026-07-16T01:00:00.000Z',
    progress: [{
      at: new Date(nowMs - progressAgeMs).toISOString(),
      message: 'autotune: GRUNER turned the dial — 1 line(s) across 1 range(s)',
    }],
  }
  const item = {
    hnId: drama.hnId,
    url: drama.url,
    title: drama.title,
    episodeId: drama.id,
    workflowId: 'workflow_stalled',
    attempt: 1,
    recoveryAttempts: 0,
    status: 'waiting',
    ...(musicWatchdog ? { musicWatchdog } : {}),
  }
  const batch = {
    date,
    status: 'running',
    target: 5,
    items: [item],
    errors: [],
  }
  const h = harness({
    now,
    settings: new Map([[nightlyBatchKey(date), batch]]),
    dramas: new Map([[drama.id, drama]]),
    topIds: [],
  })
  h.workflowStatuses.set(item.workflowId, 'waiting')
  return { batch, date, drama, h, item, nowMs }
}

test('an expiring deploy gate blocks only during its live lock window', () => {
  const now = new Date('2026-07-20T17:00:00.000Z')
  const gate = {
    state: 'locked',
    runId: '123',
    expiresAt: '2026-07-20T17:02:00.000Z',
  }
  assert.deepEqual(activeWorkflowDeployGate(gate, now), gate)
  assert.equal(workflowDeployRetryAfterSeconds(gate, now), 60)
  assert.equal(activeWorkflowDeployGate(gate, new Date(gate.expiresAt)), null)
  assert.equal(activeWorkflowDeployGate({ ...gate, state: 'released' }, now), null)
  assert.equal(activeWorkflowDeployGate({ state: 'locked', expiresAt: 'invalid' }, now), null)
})

test('nightly reconciliation makes no state changes while a deploy gate is active', async () => {
  const now = '2026-07-20T19:01:00.000Z'
  const h = harness({
    now,
    settings: new Map([[
      WORKFLOW_DEPLOY_GATE_KEY,
      {
        state: 'locked',
        runId: '123',
        expiresAt: '2026-07-20T20:00:00.000Z',
      },
    ]]),
    topIds: [123],
  })

  const batches = await runNightlyReconciliation(h.env, {
    now: new Date(now),
    dependencies: h.dependencies,
  })

  assert.deepEqual(batches, [])
  assert.deepEqual(h.creates, [])
  assert.equal(h.settings.has('dailyTopPendingDates'), false)
})

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

test('a stale active artifact restarts once from the completed music sleep without regeneration', async () => {
  const { date, drama, h } = activeArtifactFixture()

  const reconciled = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })

  assert.deepEqual(h.restarts, [{
    id: 'workflow_stalled',
    options: { from: { name: 'music write budget break', type: 'sleep' } },
  }])
  assert.equal(h.creates.length, 0)
  assert.equal(h.terminations.length, 0)
  assert.equal(h.deletes.length, 0)
  assert.equal(h.dramas.get(drama.id).artifactId, 'artifact_stable')
  assert.equal(h.dramas.get(drama.id).jobId, 'job_stable')
  assert.match(h.dramas.get(drama.id).progress.at(-1).message, /restarting from that checkpoint/i)
  assert.equal(reconciled.items[0].workflowId, 'workflow_stalled')
  assert.equal(reconciled.items[0].musicWatchdog.recoveryCount, 1)
  assert.equal(reconciled.items[0].musicWatchdog.lastAction, 'checkpoint-restart')
})

test('an active artifact with recent episode progress is not restarted', async () => {
  const { date, h } = activeArtifactFixture({
    progressAgeMs: NIGHTLY_MUSIC_STALL_TIMEOUT_MS - 1,
  })

  const reconciled = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })

  assert.equal(h.restarts.length, 0)
  assert.equal(h.creates.length, 0)
  assert.equal(h.terminations.length, 0)
  assert.equal(reconciled.items[0].musicWatchdog.recoveryCount, 0)
  assert.equal(reconciled.items[0].musicWatchdog.artifactObservedAt, '2026-07-16T06:00:00.000Z')
  assert.equal(reconciled.items[0].status, 'waiting')
})

test('an artifact with no timestamped progress gets a full observation window before restart', async () => {
  const { date, drama, h } = activeArtifactFixture()
  h.dramas.set(drama.id, { ...drama, progress: [] })

  let reconciled = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })
  assert.equal(h.restarts.length, 0)
  assert.equal(reconciled.items[0].musicWatchdog.artifactObservedAt, '2026-07-16T06:00:00.000Z')

  h.clock.now = new Date(h.clock.now.getTime() + NIGHTLY_MUSIC_STALL_TIMEOUT_MS)
  reconciled = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })
  assert.equal(h.restarts.length, 1)
  assert.equal(reconciled.items[0].musicWatchdog.recoveryCount, 1)
})

test('a stale artifact upstream of the music checkpoint stays active and observes the cooldown', async () => {
  const { date, h } = activeArtifactFixture()
  h.missingCheckpoints.add('workflow_stalled')

  let reconciled = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })

  assert.equal(h.restarts.length, 1)
  assert.equal(h.creates.length, 0)
  assert.equal(h.terminations.length, 0)
  assert.equal(reconciled.items[0].status, 'waiting')
  assert.equal(reconciled.items[0].workflowId, 'workflow_stalled')
  assert.equal(reconciled.items[0].musicWatchdog.recoveryCount, 0)
  assert.match(reconciled.items[0].musicWatchdog.lastCheckpointError, /no workflow step matching/i)

  h.clock.now = new Date(h.clock.now.getTime() + NIGHTLY_MUSIC_RECOVERY_COOLDOWN_MS - 1)
  reconciled = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })
  assert.equal(h.restarts.length, 1)
  assert.equal(reconciled.items[0].status, 'waiting')
})

test('the watchdog cooldown blocks an immediate second recovery even when progress is stale', async () => {
  const now = '2026-07-16T06:00:00.000Z'
  const nowMs = Date.parse(now)
  const { date, h } = activeArtifactFixture({
    now,
    progressAgeMs: NIGHTLY_MUSIC_STALL_TIMEOUT_MS * 2,
    musicWatchdog: {
      artifactId: 'artifact_stable',
      recoveryCount: 1,
      lastAction: 'checkpoint-restart',
      lastAttemptAt: new Date(nowMs - NIGHTLY_MUSIC_RECOVERY_COOLDOWN_MS + 1).toISOString(),
      lastRecoveryAt: new Date(nowMs - NIGHTLY_MUSIC_RECOVERY_COOLDOWN_MS + 1).toISOString(),
    },
  })

  const reconciled = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })

  assert.equal(h.restarts.length, 0)
  assert.equal(h.terminations.length, 0)
  assert.equal(h.creates.length, 0)
  assert.equal(reconciled.items[0].musicWatchdog.recoveryCount, 1)
})

test('a second stale interval terminates the stuck instance and resumes the same artifact', async () => {
  const now = '2026-07-16T06:00:00.000Z'
  const nowMs = Date.parse(now)
  const { date, drama, h } = activeArtifactFixture({
    now,
    progressAgeMs: NIGHTLY_MUSIC_STALL_TIMEOUT_MS + 1,
    musicWatchdog: {
      artifactId: 'artifact_stable',
      recoveryCount: 1,
      lastAction: 'checkpoint-restart',
      lastAttemptAt: new Date(nowMs - NIGHTLY_MUSIC_RECOVERY_COOLDOWN_MS - 1).toISOString(),
      lastRecoveryAt: new Date(nowMs - NIGHTLY_MUSIC_RECOVERY_COOLDOWN_MS - 1).toISOString(),
    },
  })

  const reconciled = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })

  assert.deepEqual(h.terminations, ['workflow_stalled'])
  assert.equal(h.restarts.length, 0)
  assert.equal(h.creates.length, 1)
  assert.deepEqual(h.creates[0], {
    id: 'resume_watchdog_1',
    params: {
      dramaId: drama.id,
      url: drama.url,
      resumeArtifactId: 'artifact_stable',
      resumeRunId: 'resume_watchdog_1',
      skipPublish: false,
    },
  })
  assert.equal('repairArtifactId' in h.creates[0].params, false)
  assert.equal('storyPlanId' in h.creates[0].params, false)
  assert.equal(h.deletes.length, 0)
  assert.equal(h.dramas.get(drama.id).artifactId, 'artifact_stable')
  assert.equal(h.dramas.get(drama.id).jobId, 'job_stable')
  assert.match(h.dramas.get(drama.id).progress.at(-1).message, /existing performance/i)
  assert.equal(reconciled.items[0].episodeId, drama.id)
  assert.equal(reconciled.items[0].workflowId, 'resume_watchdog_1')
  assert.equal(reconciled.items[0].musicWatchdog.recoveryCount, 2)
  assert.equal(reconciled.items[0].musicWatchdog.lastAction, 'resume-workflow')
})

test('music wake recovery is bounded after the replacement resume Workflow', async () => {
  const now = '2026-07-16T06:00:00.000Z'
  const nowMs = Date.parse(now)
  const { date, h } = activeArtifactFixture({
    now,
    progressAgeMs: NIGHTLY_MUSIC_STALL_TIMEOUT_MS * 2,
    musicWatchdog: {
      artifactId: 'artifact_stable',
      recoveryCount: NIGHTLY_MUSIC_RECOVERY_MAX_ACTIONS,
      lastAction: 'resume-workflow',
      lastAttemptAt: new Date(nowMs - NIGHTLY_MUSIC_RECOVERY_COOLDOWN_MS - 1).toISOString(),
      lastRecoveryAt: new Date(nowMs - NIGHTLY_MUSIC_RECOVERY_COOLDOWN_MS - 1).toISOString(),
    },
  })

  const reconciled = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })

  assert.equal(h.restarts.length, 0)
  assert.equal(h.terminations.length, 0)
  assert.equal(h.creates.length, 0)
  assert.equal(reconciled.items[0].status, 'waiting')
  assert.match(reconciled.items[0].lastError, /watchdog exhausted/i)
  assert.equal(reconciled.items[0].musicWatchdog.recoveryCount, NIGHTLY_MUSIC_RECOVERY_MAX_ACTIONS)
})

test('nightly selection adopts active work and starts one globally serialized generator', async () => {
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

  assert.equal(batch.items.length, 2)
  assert.deepEqual(batch.items.map((item) => item.hnId), ['2', '3'])
  assert.equal(h.creates.length, 1)
  assert.equal(h.creates[0].params.staggerSec, 0)
  assert.equal(h.settings.get('dailyTopLastRun'), undefined)
})

test('nightly refuses to create a workflow when the linked article is unavailable', async () => {
  const h = harness({ topIds: [30] })
  const originalFetchThread = h.dependencies.fetchThread
  h.dependencies.fetchThread = async (url) => ({
    ...await originalFetchThread(url),
    articleUrl: 'https://publisher.example/unavailable',
  })
  h.dependencies.fetchArticle = async () => {
    const error = new Error('Source article returned HTTP 403.')
    error.code = 'article_unavailable'
    throw error
  }

  const batch = await reconcileNightlyBatch(h.env, '2026-07-15', {
    dependencies: h.dependencies,
  })

  assert.equal(h.creates.length, 0)
  assert.equal(h.dramas.size, 0)
  assert.equal(batch.items.length, 0)
  assert.match(batch.errors.at(-1).message, /HN 30: Source article returned HTTP 403/)
})

test('nightly rejects an incomplete source before reserving the generation slot and selects the next story', async () => {
  const h = harness({ topIds: [30, 31] })
  const originalFetchThread = h.dependencies.fetchThread
  h.dependencies.fetchThread = async (url) => {
    const thread = await originalFetchThread(url)
    return String(thread.id) === '30'
      ? { ...thread, articleUrl: 'https://publisher.example/unavailable' }
      : thread
  }
  h.dependencies.fetchArticle = async () => {
    const error = new Error('Source article returned HTTP 403.')
    error.code = 'article_unavailable'
    throw error
  }

  const batch = await reconcileNightlyBatch(h.env, '2026-07-15', {
    dependencies: h.dependencies,
  })

  assert.equal(h.creates.length, 1)
  assert.equal(batch.items.length, 1)
  assert.equal(batch.items[0].hnId, '31')
  assert.match(batch.errors[0].message, /HN 30: Source article returned HTTP 403/)
})

test('nightly records full article and comment proof before creating a workflow', async () => {
  const h = harness({ topIds: [31] })
  const completeArticleText = `ARTICLE-BEGIN ${'complete article. '.repeat(40)} ARTICLE-END`
  const originalFetchThread = h.dependencies.fetchThread
  h.dependencies.fetchThread = async (url) => ({
    ...await originalFetchThread(url),
    articleUrl: 'https://publisher.example/full',
  })
  h.dependencies.fetchArticle = async (url) => ({
    url,
    requestedUrl: url,
    contentType: 'text/html',
    rawByteSize: 2_000,
    title: 'Complete article',
    byline: null,
    publishedTime: null,
    text: completeArticleText,
    charCount: completeArticleText.length,
    complete: true,
    truncated: false,
    fetchedAt: '2026-07-16T06:00:00.000Z',
  })

  const batch = await reconcileNightlyBatch(h.env, '2026-07-15', {
    dependencies: h.dependencies,
  })

  assert.equal(h.creates.length, 1)
  const drama = h.dramas.get(batch.items[0].episodeId)
  assert.equal(drama.sourceCompleteness.comments.expected, 50)
  assert.equal(drama.sourceCompleteness.comments.fetched, 50)
  assert.equal(drama.sourceCompleteness.article.complete, true)
  assert.equal(drama.sourceCompleteness.article.url, 'https://publisher.example/full')
  assert.match(drama.progress[0].message, /50\/50 comments and full article/)
})

test('a ready but unpublished MP3 gets a publish-only recovery, never a re-finalize', async () => {
  // The paid loop this closes: a publish refusal was swallowed, the episode
  // stayed unpublished, and every hour the reconciler re-ran post-production
  // AND finalize on an MP3 that was already finished — 364 finalizes in a week.
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
  assert.deepEqual(h.creates[0].params, {
    dramaId: drama.id,
    url: drama.url,
    publishOnly: true,
    publishRunId: 'resume_watchdog_1',
  })
  assert.equal(h.creates[0].params.resumeArtifactId, undefined, 'no post-production, no re-finalize')
  assert.equal(reconciled.items[0].episodeId, drama.id)
  assert.equal(reconciled.items[0].recoveryAttempts, 0, 'publishing spends no artifact-recovery attempt')
  assert.equal(reconciled.items[0].publishAttempts, 1)
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
  assert.equal(reconciled.items[0].publishAttempts, 1)
  assert.equal(h.creates[0].params.publishOnly, true)
  assert.equal(reconciled.published, 0)
})

test('a provider quota cliff opens an episode-probed circuit, then retries the same job on the hourly probe', async () => {
  const h = harness({ topIds: [] })
  const date = '2026-07-17'
  h.dramas.set('episode_quota', {
    id: 'episode_quota',
    hnId: '77',
    status: 'failed',
    error: 'Planning failed after the first completed generation. This request requires more credits, or fewer max_tokens. You requested up to 24000 tokens, but can only afford 7900. To increase, visit https://openrouter.ai/settings/credits and add more credits.',
    jobId: 'job_quota',
    url: 'https://news.ycombinator.com/item?id=77',
    progress: [],
  })
  h.settings.set(nightlyBatchKey(date), {
    date,
    status: 'running',
    target: 5,
    items: [{
      hnId: '77',
      url: 'https://news.ycombinator.com/item?id=77',
      title: 'Story 77',
      episodeId: 'episode_quota',
      workflowId: 'episode_quota',
      attempt: 3,
      recoveryAttempts: 0,
      status: 'failed',
    }],
    errors: [],
  })

  let batch = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })
  let item = batch.items[0]
  assert.equal(item.status, 'blocked')
  assert.equal(item.attempt, 3, 'quota failures must not consume the attempt budget')
  assert.ok(item.providerQuotaBlockedAt)
  assert.equal(item.quotaBlockedAt, undefined, 'OpenRouter\'s balance is not Studio Credits')
  assert.equal(h.creates.length, 0, 'opening the circuit does not fan out immediately')
  const circuit = h.settings.get(NIGHTLY_GENERATION_CIRCUIT_KEY)
  assert.equal(circuit.failureClass, 'provider_quota')
  assert.equal(circuit.probe, 'episode')

  h.clock.now = new Date(h.clock.now.getTime() + NIGHTLY_SYSTEMIC_PROBE_COOLDOWN_MS)
  batch = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })
  item = batch.items[0]
  assert.equal(item.status, 'queued')
  assert.equal(item.attempt, 3)
  assert.equal(item.episodeId, 'episode_quota')
  assert.equal(h.creates.length, 1)
  assert.deepEqual(h.creates[0].params, {
    dramaId: 'episode_quota',
    url: 'https://news.ycombinator.com/item?id=77',
    resumeJobId: 'job_quota',
    recoveryRunId: 'resume_watchdog_1',
  })
  assert.equal(h.dramas.get('episode_quota').status, 'queued')
  assert.equal(h.dramas.get('episode_quota').error, null)
})

test('an episode that failed before it had a job is replaced with a fully prepared source', async () => {
  // An episode that dies in `fetch complete thread` never reaches a jobId or a
  // planId, so there is nothing to resume and reconciliation must build a fresh
  // replacement. That path has to hand createEpisodeWorkflow the SAME prepared
  // source a first attempt gets — thread plus completeness metadata — not the
  // bare thread. Passing the thread alone made every retry throw
  // "Cannot read properties of undefined (reading 'id')" before it could queue
  // anything, which turned each transient failure into a permanent one.
  const h = harness({ topIds: [] })
  const date = '2026-07-17'
  // A plain, non-systemic failure, so this test measures the replacement path
  // alone. Source-lag holds are covered separately.
  h.dramas.set('episode_unsynced', {
    id: 'episode_unsynced',
    hnId: '77',
    status: 'failed',
    error: 'Table-read script generation produced empty output.',
    url: 'https://news.ycombinator.com/item?id=77',
    progress: [],
  })
  h.settings.set(nightlyBatchKey(date), {
    date,
    status: 'running',
    target: 5,
    items: [{
      hnId: '77',
      url: 'https://news.ycombinator.com/item?id=77',
      title: 'Story 77',
      episodeId: 'episode_unsynced',
      workflowId: 'episode_unsynced',
      attempt: 1,
      recoveryAttempts: 0,
      status: 'failed',
    }],
    errors: [],
  })

  const batch = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })
  const item = batch.items[0]

  assert.equal(item.lastError ?? null, null, 'the replacement path must not throw')
  assert.equal(item.status, 'queued')
  assert.equal(item.attempt, 2, 'a fresh replacement consumes an attempt')
  assert.equal(h.creates.length, 1, 'exactly one replacement Workflow is queued')

  // The replacement drama proves the prepared source was destructured: reading
  // `thread.id` off a bare thread is what used to throw.
  const replacement = h.dramas.get(item.episodeId)
  assert.ok(replacement, 'the replacement episode row exists')
  assert.equal(replacement.hnId, '77')
  assert.equal(replacement.status, 'queued')
  assert.notEqual(item.episodeId, 'episode_unsynced', 'the replacement is a new episode')
})

test('a recorded failed probe is rearmed when its next recovery window arrives', async () => {
  const now = '2026-07-19T06:00:00.000Z'
  const date = '2026-07-18'
  const h = harness({
    now,
    topIds: [],
    randomIds: ['replacement_probe_1'],
  })
  h.workflowStatuses.set('failed_probe_workflow', 'errored')
  h.settings.set(NIGHTLY_GENERATION_CIRCUIT_KEY, {
    state: 'open',
    failureClass: 'provider',
    failureMessage: 'provider blocked',
    openedAt: '2026-07-19T02:00:00.000Z',
    lastProbeAt: '2026-07-19T04:00:00.000Z',
    lastProbeFailureAt: '2026-07-19T05:00:00.000Z',
    nextProbeAt: now,
    probeEpisodeId: 'episode_failed_probe',
    probeWorkflowId: 'failed_probe_workflow',
  })
  h.dramas.set('episode_failed_probe', {
    id: 'episode_failed_probe',
    hnId: '78',
    status: 'failed',
    failureClass: 'provider',
    failureCode: 'provider_capacity_blocked',
    failureMessage: 'Detected high-frequency non-compliant requests from you.',
    error: 'Detected high-frequency non-compliant requests from you.',
    jobId: 'job_failed_probe',
    url: 'https://news.ycombinator.com/item?id=78',
    progress: [],
  })
  h.settings.set(nightlyBatchKey(date), {
    date,
    status: 'running',
    target: 5,
    items: [{
      hnId: '78',
      url: 'https://news.ycombinator.com/item?id=78',
      title: 'Story 78',
      episodeId: 'episode_failed_probe',
      workflowId: 'failed_probe_workflow',
      attempt: 1,
      recoveryAttempts: 0,
      status: 'blocked',
    }],
    errors: [],
  })

  const batch = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })

  assert.equal(batch.items[0].status, 'queued')
  assert.equal(h.creates.length, 1)
  assert.deepEqual(h.creates[0].params, {
    dramaId: 'episode_failed_probe',
    url: 'https://news.ycombinator.com/item?id=78',
    resumeJobId: 'job_failed_probe',
    recoveryRunId: 'replacement_probe_1',
  })
  const circuit = h.settings.get(NIGHTLY_GENERATION_CIRCUIT_KEY)
  assert.equal(circuit.probeWorkflowId, 'replacement_probe_1')
  assert.equal(circuit.lastProbeAt, now)
  assert.equal(
    circuit.nextProbeAt,
    new Date(Date.parse(now) + NIGHTLY_SYSTEMIC_PROBE_COOLDOWN_MS).toISOString(),
  )
})

test('an empty nightly batch launches exactly one due generation-circuit probe', async () => {
  const now = '2026-07-22T00:10:00.000Z'
  const date = '2026-07-21'
  const h = harness({ now, topIds: [501, 502, 503] })
  h.workflowStatuses.set('failed_probe_workflow', 'errored')
  h.settings.set(NIGHTLY_GENERATION_CIRCUIT_KEY, {
    state: 'open',
    failureClass: 'provider',
    failureMessage: 'provider blocked',
    openedAt: '2026-07-21T20:00:00.000Z',
    nextProbeAt: '2026-07-21T23:00:00.000Z',
    probeCount: 1,
    probeEpisodeId: 'failed_probe_episode',
    probeWorkflowId: 'failed_probe_workflow',
  })

  const batch = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })

  assert.equal(h.creates.length, 1)
  assert.equal(batch.items.length, 1)
  assert.equal(batch.items[0].hnId, '501')
  const circuit = h.settings.get(NIGHTLY_GENERATION_CIRCUIT_KEY)
  assert.equal(circuit.probeCount, 2)
  assert.equal(circuit.probeEpisodeId, batch.items[0].episodeId)
  assert.equal(circuit.probeWorkflowId, batch.items[0].workflowId)
  assert.equal(circuit.probeWorkflowId, h.creates[0].id)
})

test('an empty batch waits when the generation-circuit probe cooldown is not due', async () => {
  const now = '2026-07-22T00:10:00.000Z'
  const date = '2026-07-21'
  const h = harness({ now, topIds: [511, 512] })
  h.settings.set(NIGHTLY_GENERATION_CIRCUIT_KEY, {
    state: 'open',
    failureClass: 'provider',
    failureMessage: 'provider blocked',
    openedAt: '2026-07-21T20:00:00.000Z',
    nextProbeAt: '2026-07-22T00:30:00.000Z',
  })

  const batch = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })

  assert.equal(h.creates.length, 0)
  assert.equal(batch.items.length, 0)
  assert.equal(
    h.settings.get(NIGHTLY_GENERATION_CIRCUIT_KEY).nextProbeAt,
    '2026-07-22T00:30:00.000Z',
  )
})

test('an empty batch does not overlap an active generation-circuit probe', async () => {
  const now = '2026-07-22T00:10:00.000Z'
  const date = '2026-07-21'
  const h = harness({ now, topIds: [521, 522] })
  h.workflowStatuses.set('active_probe_workflow', 'waiting')
  h.settings.set(NIGHTLY_GENERATION_CIRCUIT_KEY, {
    state: 'open',
    failureClass: 'provider',
    failureMessage: 'provider blocked',
    openedAt: '2026-07-21T20:00:00.000Z',
    nextProbeAt: '2026-07-21T23:00:00.000Z',
    probeEpisodeId: 'active_probe_episode',
    probeWorkflowId: 'active_probe_workflow',
  })

  const batch = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })

  assert.equal(h.creates.length, 0)
  assert.equal(batch.items.length, 0)
  assert.equal(
    h.settings.get(NIGHTLY_GENERATION_CIRCUIT_KEY).probeWorkflowId,
    'active_probe_workflow',
  )
})

test('an ordinary failure at the attempt cap still exhausts the story', async () => {
  const h = harness({ topIds: [] })
  const date = '2026-07-17'
  h.dramas.set('episode_flaky', {
    id: 'episode_flaky',
    hnId: '78',
    status: 'failed',
    error: 'Table-read script generation produced empty output.',
    url: 'https://news.ycombinator.com/item?id=78',
    progress: [],
  })
  h.settings.set(nightlyBatchKey(date), {
    date,
    status: 'running',
    target: 5,
    items: [{
      hnId: '78',
      url: 'https://news.ycombinator.com/item?id=78',
      title: 'Story 78',
      episodeId: 'episode_flaky',
      workflowId: 'episode_flaky',
      attempt: 3,
      recoveryAttempts: 0,
      status: 'failed',
    }],
    errors: [],
  })

  const batch = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })
  assert.equal(batch.items[0].status, 'exhausted')
  assert.equal(h.creates.length, 0)
})

test('a quota-blocked batch emails the operator exactly once', async (t) => {
  const h = harness({ topIds: [] })
  h.env.RESEND_API_KEY = 'test_resend_key'
  h.env.ALERT_EMAIL = 'ops@example.com'
  const emails = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    emails.push({ url, body: JSON.parse(options.body) })
    return { ok: true, json: async () => ({ id: 'email_1' }) }
  }
  t.after(() => { globalThis.fetch = realFetch })

  const date = '2026-07-17'
  const seed = () => h.settings.set(nightlyBatchKey(date), structuredClone({
    date,
    status: 'running',
    target: 5,
    items: [{
      hnId: '77',
      url: 'https://news.ycombinator.com/item?id=77',
      title: 'Story 77',
      episodeId: 'missing',
      workflowId: null,
      attempt: 1,
      recoveryAttempts: 0,
      status: 'failed',
      lastError: 'You have reached your specified API usage limits.',
      quotaBlockedAt: '2026-07-17T01:00:00.000Z',
    }],
    errors: [],
  }))

  seed()
  await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })
  assert.equal(emails.length, 1)
  assert.match(emails[0].body.subject, /provider quota cliff/)
  assert.deepEqual(emails[0].body.to, ['ops@example.com'])

  await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })
  assert.equal(emails.length, 1, 'the alert is rate-limited to one per date per type')
})

test('no alert is attempted without Resend configuration', async (t) => {
  const h = harness({ topIds: [] })
  let called = false
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => { called = true; return { ok: true, json: async () => ({}) } }
  t.after(() => { globalThis.fetch = realFetch })

  const date = '2026-07-17'
  h.settings.set(nightlyBatchKey(date), {
    date,
    status: 'running',
    target: 5,
    items: [{ hnId: '77', url: 'https://news.ycombinator.com/item?id=77', title: 'Story 77', episodeId: 'missing', attempt: 1, status: 'failed', lastError: 'You have reached your specified API usage limits.' }],
    errors: [],
  })
  await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })
  assert.equal(called, false)
})

test('a contract-class failure alerts immediately, opens the circuit, and preserves attempts', async (t) => {
  const h = harness({ topIds: [] })
  h.env.RESEND_API_KEY = 'test_resend_key'
  h.env.ALERT_EMAIL = 'ops@example.com'
  const emails = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    emails.push(JSON.parse(options.body))
    return { ok: true, json: async () => ({ id: 'email_1' }) }
  }
  t.after(() => { globalThis.fetch = realFetch })

  const date = '2026-07-18'
  h.dramas.set('episode_contract', {
    id: 'episode_contract',
    hnId: '90',
    status: 'failed',
    error: 'SleeperHitError: `creativeBrief` is invalid: mustKnowBeforeWriting - Too big: expected array to have <=12 items',
    url: 'https://news.ycombinator.com/item?id=90',
    progress: [],
  })
  h.settings.set(nightlyBatchKey(date), {
    date,
    status: 'running',
    target: 5,
    items: [{
      hnId: '90',
      url: 'https://news.ycombinator.com/item?id=90',
      title: 'Story 90',
      episodeId: 'episode_contract',
      workflowId: 'episode_contract',
      attempt: 3,
      recoveryAttempts: 0,
      status: 'failed',
    }],
    errors: [],
  })

  const batch = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })
  const item = batch.items[0]
  assert.equal(item.attempt, 3, 'contract failures must not consume the attempt budget')
  assert.ok(item.contractBlockedAt)
  assert.equal(item.status, 'blocked', 'the circuit waits for its hourly probe')
  assert.equal(h.creates.length, 0)
  assert.equal(h.settings.get(NIGHTLY_GENERATION_CIRCUIT_KEY).failureClass, 'contract')
  assert.equal(emails.length, 1, 'contract failures alert on FIRST occurrence')
  assert.match(emails[0].subject, /contract\/validation error/)
})

// 2026-10-03, the first comedy-canary episode: the platform's planner produced a whole plan and returned
// its last field as a JSON string. A model's schema miss, once in 14 days of plans, not the platform
// refusing what HNR sent. It used to classify as contract: open the generation circuit, email the
// operator "deterministic", and stop the show. It is an ordinary item failure the next attempt retries.
const NEWGROUNDS_PLAN_MISS = 'Planning failed after the first completed generation. Schema validation failed — artifacts: Invalid input: expected array, received string'

test('a planner answer that missed its schema is retryable, never contract; a refused request still is', () => {
  assert.equal(classifySystemicFailure(NEWGROUNDS_PLAN_MISS), null)
  assert.equal(classifySystemicFailure({ failureCode: 'story_plan_failed', failureMessage: NEWGROUNDS_PLAN_MISS }), null)
  assert.equal(isModelOutputMissFailure(NEWGROUNDS_PLAN_MISS), true)
  assert.equal(classifySystemicFailure('No object generated: response did not match schema.'), null)
  // A model output that is also "Too big:" is still the model's miss.
  assert.equal(classifySystemicFailure('Planning failed after the first completed generation. Schema validation failed — title: Too big: expected string to have <=240 characters'), null)
  // What HNR SENT, refused by the platform's request validation, stays contract.
  assert.equal(classifySystemicFailure('SleeperHitError: `artifactRequests[0]` is invalid: notes - Too big: expected string to have <=5000 characters'), 'contract')
  assert.equal(classifySystemicFailure('SleeperHitError: `creativeBrief` is invalid: mustKnowBeforeWriting - Too big: expected array to have <=12 items'), 'contract')
  assert.equal(isModelOutputMissFailure('`creativeBrief` is invalid: Too big'), false)
})

test('a planner schema miss stored as contract opens no circuit, sends no alert, and resumes its plan', async (t) => {
  const h = harness({ topIds: [], randomIds: ['resume_newgrounds'] })
  h.env.RESEND_API_KEY = 'test_resend_key'
  h.env.ALERT_EMAIL = 'ops@example.com'
  const emails = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (_url, options) => {
    emails.push(JSON.parse(options.body))
    return { ok: true, json: async () => ({ id: 'email_1' }) }
  }
  t.after(() => { globalThis.fetch = realFetch })

  const date = '2026-10-02'
  // As prod stored it: the pipeline classified it at failure time, under the old rule.
  h.dramas.set('episode_newgrounds', {
    id: 'episode_newgrounds',
    hnId: '49940394',
    status: 'failed',
    failureClass: 'contract',
    failureCode: 'story_plan_failed',
    failureMessage: NEWGROUNDS_PLAN_MISS,
    error: NEWGROUNDS_PLAN_MISS,
    planId: 'cmus3r91e001xi8073wt3td1y',
    url: 'https://news.ycombinator.com/item?id=49940394',
    progress: [],
  })
  h.settings.set(nightlyBatchKey(date), {
    date,
    status: 'running',
    target: 5,
    items: [{
      hnId: '49940394',
      url: 'https://news.ycombinator.com/item?id=49940394',
      title: 'Newgrounds.com – A community of games, music, and art',
      episodeId: 'episode_newgrounds',
      workflowId: 'episode_newgrounds',
      attempt: 1,
      recoveryAttempts: 0,
      status: 'failed',
    }],
    errors: [],
  })

  const batch = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })
  const item = batch.items[0]
  assert.equal(item.contractBlockedAt, undefined)
  assert.equal(h.settings.get(NIGHTLY_GENERATION_CIRCUIT_KEY)?.state === 'open', false, 'no generation circuit')
  assert.equal(emails.length, 0, 'no distress alert for a model miss')
  // The normal retry: the same plan, re-run by the platform.
  assert.equal(h.creates.length, 1)
  assert.equal(h.creates[0].params.resumePlanId, 'cmus3r91e001xi8073wt3td1y')
  assert.equal(h.creates[0].params.dramaId, 'episode_newgrounds')
  assert.notEqual(item.status, 'blocked')
})

test('provider policy throttles use the stable failure code and get their own alert class', async (t) => {
  assert.equal(classifySystemicFailure({
    failureCode: 'provider_capacity_blocked',
    failureMessage: 'opaque provider response',
  }), 'provider')
  assert.equal(classifySystemicFailure(
    'Detected high-frequency non-compliant requests from you. Please retry later.',
  ), 'provider')
  assert.equal(classifySystemicFailure(
    'Table-read outline page budgets total 18, but scriptBlueprint.pageTarget is 20.',
  ), 'contract')

  const h = harness({ topIds: [] })
  h.env.RESEND_API_KEY = 'test_resend_key'
  h.env.ALERT_EMAIL = 'ops@example.com'
  const emails = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (_url, options) => {
    emails.push(JSON.parse(options.body))
    return { ok: true, json: async () => ({ id: 'email_provider' }) }
  }
  t.after(() => { globalThis.fetch = realFetch })

  const date = '2026-07-18'
  h.dramas.set('episode_provider', {
    id: 'episode_provider',
    hnId: '91',
    status: 'failed',
    error: 'writer failed',
    failureCode: 'provider_capacity_blocked',
    failureMessage: 'Detected high-frequency non-compliant requests from you.',
    jobId: 'job_provider',
    url: 'https://news.ycombinator.com/item?id=91',
    progress: [],
  })
  h.settings.set(nightlyBatchKey(date), {
    date,
    status: 'running',
    target: 5,
    items: [{
      hnId: '91',
      url: 'https://news.ycombinator.com/item?id=91',
      title: 'Story 91',
      episodeId: 'episode_provider',
      workflowId: 'episode_provider',
      attempt: 1,
      recoveryAttempts: 0,
      status: 'failed',
    }],
    errors: [],
  })

  const batch = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })
  assert.equal(batch.items[0].status, 'blocked')
  assert.ok(batch.items[0].providerBlockedAt)
  assert.equal(h.creates.length, 0)
  assert.equal(emails.length, 1)
  assert.match(emails[0].subject, /provider policy throttle/)
})

test('one due generation circuit gives the single probe to the newest pending date', async () => {
  const firstDate = '2026-07-17'
  const secondDate = '2026-07-18'
  const now = '2026-07-19T06:00:00.000Z'
  const h = harness({
    now,
    topIds: [],
    randomIds: ['global_probe_1'],
  })
  h.settings.set('dailyTopPendingDates', [firstDate, secondDate])
  h.settings.set(NIGHTLY_GENERATION_CIRCUIT_KEY, {
    state: 'open',
    failureClass: 'provider',
    failureMessage: 'provider blocked',
    openedAt: '2026-07-19T04:00:00.000Z',
    nextProbeAt: '2026-07-19T05:00:00.000Z',
  })

  for (const [index, date] of [firstDate, secondDate].entries()) {
    const episodeId = `episode_global_${index + 1}`
    h.dramas.set(episodeId, {
      id: episodeId,
      hnId: String(201 + index),
      status: 'failed',
      failureClass: 'provider',
      failureCode: 'provider_capacity_blocked',
      failureMessage: 'Detected high-frequency non-compliant requests from you.',
      error: 'Detected high-frequency non-compliant requests from you.',
      jobId: `job_global_${index + 1}`,
      url: `https://news.ycombinator.com/item?id=${201 + index}`,
      progress: [],
    })
    h.settings.set(nightlyBatchKey(date), {
      date,
      status: 'running',
      target: 5,
      items: [{
        hnId: String(201 + index),
        url: `https://news.ycombinator.com/item?id=${201 + index}`,
        title: `Story ${201 + index}`,
        episodeId,
        workflowId: episodeId,
        attempt: 1,
        recoveryAttempts: 0,
        status: 'blocked',
      }],
      errors: [],
    })
  }

  const batches = await runNightlyReconciliation(h.env, {
    now: new Date(now),
    dependencies: h.dependencies,
  })

  assert.equal(batches.length, 2)
  assert.equal(h.creates.length, 1)
  assert.equal(h.creates[0].params.resumeJobId, 'job_global_2')
  assert.equal(batches[0].items[0].status, 'superseded')
  assert.equal(batches[0].status, 'superseded')
  assert.equal(batches[1].items[0].status, 'queued')
  const circuit = h.settings.get(NIGHTLY_GENERATION_CIRCUIT_KEY)
  assert.equal(circuit.probeEpisodeId, 'episode_global_2')
  assert.equal(circuit.probeWorkflowId, 'global_probe_1')
  assert.equal(circuit.probeCount, 1)
  assert.deepEqual(h.settings.get('dailyTopPendingDates'), [secondDate])
})

test('closed-circuit reconciliation starts only one generator across pending dates', async () => {
  const firstDate = '2026-07-17'
  const secondDate = '2026-07-18'
  const h = harness({
    now: '2026-07-19T06:00:00.000Z',
    topIds: [301, 302, 303],
  })
  h.settings.set('dailyTopPendingDates', [firstDate, secondDate])
  h.settings.set(nightlyBatchKey(firstDate), {
    date: firstDate,
    status: 'running',
    target: 5,
    items: [],
    errors: [],
  })
  h.settings.set(nightlyBatchKey(secondDate), {
    date: secondDate,
    status: 'running',
    target: 5,
    items: [],
    errors: [],
  })

  const batches = await runNightlyReconciliation(h.env, {
    now: new Date('2026-07-19T06:00:00.000Z'),
    dependencies: h.dependencies,
  })

  assert.equal(h.creates.length, 1)
  assert.equal(batches[0].status, 'superseded')
  assert.equal(batches[0].items.length, 0)
  assert.equal(batches[1].status, 'running')
  assert.deepEqual(batches[1].items.map((item) => item.hnId), ['301'])
  assert.deepEqual(h.settings.get('dailyTopPendingDates'), [secondDate])
})

test('the same failed episode is resumed only once when two dates reference it', async () => {
  const firstDate = '2026-07-17'
  const secondDate = '2026-07-18'
  const episode = {
    id: 'episode_shared',
    hnId: '401',
    status: 'failed',
    error: 'temporary upstream failure',
    planId: 'plan_shared',
    url: 'https://news.ycombinator.com/item?id=401',
    title: 'Story 401',
    progress: [],
  }
  const sharedItem = {
    hnId: episode.hnId,
    url: episode.url,
    title: episode.title,
    episodeId: episode.id,
    workflowId: episode.id,
    attempt: 1,
    recoveryAttempts: 0,
    status: 'failed',
  }
  const h = harness({
    now: '2026-07-19T06:00:00.000Z',
    dramas: new Map([[episode.id, episode]]),
    topIds: [],
    randomIds: ['shared_resume_1'],
  })
  h.settings.set('dailyTopPendingDates', [firstDate, secondDate])
  for (const date of [firstDate, secondDate]) {
    h.settings.set(nightlyBatchKey(date), {
      date,
      status: 'running',
      target: 5,
      items: [structuredClone(sharedItem)],
      errors: [],
    })
  }

  const batches = await runNightlyReconciliation(h.env, {
    now: new Date('2026-07-19T06:00:00.000Z'),
    dependencies: h.dependencies,
  })

  assert.equal(h.creates.length, 1)
  assert.equal(h.creates[0].params.resumePlanId, episode.planId)
  assert.equal(batches[0].items[0].status, 'superseded')
  assert.equal(batches[1].items[0].status, 'queued')
  assert.equal(h.dramas.get(episode.id).status, 'queued')
})

test('the newest batch exclusively owns artifact recovery for a shared episode', async () => {
  const firstDate = '2026-07-17'
  const secondDate = '2026-07-18'
  const episode = {
    id: 'episode_shared_artifact',
    hnId: '402',
    status: 'ready',
    artifactId: 'artifact_shared',
    audioUrl: 'https://audio.example/shared.mp3',
    url: 'https://news.ycombinator.com/item?id=402',
    title: 'Story 402',
    progress: [{ at: '2026-07-19T05:00:00.000Z', message: 'Done — your podcast is ready.' }],
  }
  const sharedItem = {
    hnId: episode.hnId,
    url: episode.url,
    title: episode.title,
    episodeId: episode.id,
    workflowId: 'terminal_shared_workflow',
    attempt: 1,
    recoveryAttempts: 0,
    status: 'ready',
  }
  const h = harness({
    now: '2026-07-19T06:00:00.000Z',
    dramas: new Map([[episode.id, episode]]),
    topIds: [],
  })
  h.workflowStatuses.set('terminal_shared_workflow', 'errored')
  h.settings.set('dailyTopPendingDates', [firstDate, secondDate])
  for (const date of [firstDate, secondDate]) {
    h.settings.set(nightlyBatchKey(date), {
      date,
      status: 'running',
      target: 5,
      items: [structuredClone(sharedItem)],
      errors: [],
    })
  }

  const batches = await runNightlyReconciliation(h.env, {
    now: new Date('2026-07-19T06:00:00.000Z'),
    dependencies: h.dependencies,
  })

  assert.equal(h.creates.length, 1)
  // The MP3 exists, so the recovery is the publish step alone.
  assert.equal(h.creates[0].params.publishOnly, true)
  assert.equal(h.creates[0].params.dramaId, episode.id)
  assert.equal(batches[0].items[0].status, 'superseded')
  assert.equal(batches[1].items[0].status, 'queued')
})

test('a due probe resumes the same plan when failure happened before job creation', async () => {
  const date = '2026-07-18'
  const h = harness({
    now: '2026-07-19T06:00:00.000Z',
    topIds: [],
    randomIds: ['plan_probe_1'],
  })
  h.settings.set(NIGHTLY_GENERATION_CIRCUIT_KEY, {
    state: 'open',
    failureClass: 'contract',
    failureMessage: 'page budget mismatch',
    openedAt: '2026-07-19T04:00:00.000Z',
    nextProbeAt: '2026-07-19T05:00:00.000Z',
  })
  h.dramas.set('episode_plan_probe', {
    id: 'episode_plan_probe',
    hnId: '250',
    status: 'failed',
    failureClass: 'contract',
    failureMessage: 'Table-read outline page budgets total 18, but scriptBlueprint.pageTarget is 20.',
    error: 'Table-read outline page budgets total 18, but scriptBlueprint.pageTarget is 20.',
    planId: 'plan_existing',
    url: 'https://news.ycombinator.com/item?id=250',
    progress: [],
  })
  h.settings.set(nightlyBatchKey(date), {
    date,
    status: 'running',
    target: 5,
    items: [{
      hnId: '250',
      url: 'https://news.ycombinator.com/item?id=250',
      title: 'Story 250',
      episodeId: 'episode_plan_probe',
      workflowId: 'episode_plan_probe',
      attempt: 2,
      recoveryAttempts: 0,
      status: 'blocked',
    }],
    errors: [],
  })

  const batch = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })

  assert.equal(h.creates.length, 1)
  assert.deepEqual(h.creates[0].params, {
    dramaId: 'episode_plan_probe',
    url: 'https://news.ycombinator.com/item?id=250',
    resumePlanId: 'plan_existing',
    recoveryRunId: 'plan_probe_1',
  })
  assert.equal(batch.items[0].episodeId, 'episode_plan_probe')
  assert.equal(batch.items[0].attempt, 2)
})

test('an hourly probe is not overlapped while its Workflow is still active', async () => {
  const date = '2026-07-18'
  const h = harness({ now: '2026-07-19T06:00:00.000Z', topIds: [] })
  h.workflowStatuses.set('active_probe_workflow', 'waiting')
  h.settings.set(NIGHTLY_GENERATION_CIRCUIT_KEY, {
    state: 'open',
    failureClass: 'provider',
    failureMessage: 'provider blocked',
    openedAt: '2026-07-19T03:00:00.000Z',
    nextProbeAt: '2026-07-19T05:00:00.000Z',
    probeEpisodeId: 'different_probe_episode',
    probeWorkflowId: 'active_probe_workflow',
  })
  h.dramas.set('episode_waiting_for_probe', {
    id: 'episode_waiting_for_probe',
    hnId: '260',
    status: 'failed',
    failureClass: 'provider',
    failureCode: 'provider_capacity_blocked',
    failureMessage: 'Detected high-frequency non-compliant requests from you.',
    jobId: 'job_waiting_for_probe',
    url: 'https://news.ycombinator.com/item?id=260',
    progress: [],
  })
  h.settings.set(nightlyBatchKey(date), {
    date,
    status: 'running',
    target: 5,
    items: [{
      hnId: '260',
      url: 'https://news.ycombinator.com/item?id=260',
      title: 'Story 260',
      episodeId: 'episode_waiting_for_probe',
      workflowId: 'old_failed_workflow',
      attempt: 1,
      recoveryAttempts: 0,
      status: 'blocked',
    }],
    errors: [],
  })

  const batch = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })

  assert.equal(h.creates.length, 0)
  assert.equal(batch.items[0].status, 'blocked')
  assert.equal(h.settings.get(NIGHTLY_GENERATION_CIRCUIT_KEY).probeWorkflowId, 'active_probe_workflow')
})

test('a probe producing an artifact closes the circuit without same-tick fan-out', async () => {
  const date = '2026-07-18'
  const h = harness({ topIds: [301, 302, 303, 304] })
  const drama = {
    id: 'episode_probe_success',
    hnId: '300',
    status: 'running',
    artifactId: 'artifact_probe_success',
    url: 'https://news.ycombinator.com/item?id=300',
    progress: [{ at: h.clock.now.toISOString(), message: 'Performance created.' }],
  }
  h.dramas.set(drama.id, drama)
  h.workflowStatuses.set('workflow_probe_success', 'waiting')
  h.settings.set(NIGHTLY_GENERATION_CIRCUIT_KEY, {
    state: 'open',
    failureClass: 'provider',
    openedAt: '2026-07-16T00:00:00.000Z',
    nextProbeAt: '2026-07-16T01:00:00.000Z',
    probeEpisodeId: drama.id,
    probeWorkflowId: 'workflow_probe_success',
  })
  h.settings.set(nightlyBatchKey(date), {
    date,
    status: 'running',
    target: 5,
    items: [{
      hnId: drama.hnId,
      url: drama.url,
      title: 'Story 300',
      episodeId: drama.id,
      workflowId: 'workflow_probe_success',
      attempt: 1,
      recoveryAttempts: 0,
      status: 'waiting',
    }],
    errors: [],
  })

  const batch = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })

  assert.equal(h.settings.get(NIGHTLY_GENERATION_CIRCUIT_KEY), null)
  assert.equal(batch.items.length, 1)
  assert.equal(h.creates.length, 0)

  const nextTick = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })
  assert.equal(nextTick.items.length, 2)
  assert.equal(h.creates.length, 1, 'the next invocation may refill, but remains globally serialized')
})

test('cumulative failure events fire the failing alert after one full wave', async (t) => {
  const h = harness({ topIds: [] })
  h.env.RESEND_API_KEY = 'test_resend_key'
  h.env.ALERT_EMAIL = 'ops@example.com'
  const emails = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    emails.push(JSON.parse(options.body))
    return { ok: true, json: async () => ({ id: 'email_1' }) }
  }
  t.after(() => { globalThis.fetch = realFetch })

  const date = '2026-07-18'
  const items = []
  for (let i = 0; i < 5; i++) {
    const id = `episode_flaky_${i}`
    h.dramas.set(id, {
      id,
      hnId: String(100 + i),
      status: 'failed',
      error: 'Table-read script generation produced empty output.',
      url: `https://news.ycombinator.com/item?id=${100 + i}`,
      progress: [],
    })
    items.push({
      hnId: String(100 + i),
      url: `https://news.ycombinator.com/item?id=${100 + i}`,
      title: `Story ${100 + i}`,
      episodeId: id,
      workflowId: id,
      attempt: 1,
      recoveryAttempts: 0,
      status: 'failed',
    })
  }
  h.settings.set(nightlyBatchKey(date), {
    date, status: 'running', target: 5, items, errors: [],
  })

  const batch = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })
  assert.equal(batch.failureEvents, 5)
  assert.equal(emails.length, 1, 'one full-wave wipeout with zero published alerts on the next tick')
  assert.match(emails[0].subject, /failing repeatedly/)
})

function unsyncedThreadBatch(h, date, overrides = {}) {
  h.dramas.set('episode_lag', {
    id: 'episode_lag',
    hnId: '77',
    status: 'failed',
    error: 'HNError: Hacker News thread 77 is not synchronized yet: official count 117, Algolia count 116, decoded 116, need at least 106.',
    url: 'https://news.ycombinator.com/item?id=77',
    progress: [],
  })
  h.settings.set(nightlyBatchKey(date), {
    date,
    status: 'running',
    target: 5,
    items: [{
      hnId: '77',
      url: 'https://news.ycombinator.com/item?id=77',
      title: 'Story 77',
      episodeId: 'episode_lag',
      workflowId: 'episode_lag',
      attempt: 1,
      recoveryAttempts: 0,
      status: 'failed',
      ...overrides,
    }],
    errors: [],
  })
}

test('a thread whose index has not caught up does not spend an attempt', async () => {
  // Three attempts is the whole nightly budget. Spending one on a search index
  // that is seconds behind drops the story for the night, and it is exactly the
  // busiest threads — the ones worth an episode — that lag.
  const h = harness({ topIds: [] })
  const date = '2026-07-17'
  unsyncedThreadBatch(h, date)

  const batch = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })
  const item = batch.items[0]

  assert.equal(item.status, 'queued')
  assert.equal(item.attempt, 1, 'index lag is free')
  assert.equal(item.sourceLagHolds, 1)
  assert.ok(item.sourceLagAt)
  assert.equal(h.creates.length, 1, 'it still retries immediately')
})

test('a source the platform refused because its comment count moved is held for free, not spent', async () => {
  // The Flock item, 2026-10-04: the same index-lag race, refused at upload by the platform's own check.
  const h = harness({ topIds: [] })
  const date = '2026-10-03'
  unsyncedThreadBatch(h, date)
  h.dramas.set('episode_lag', {
    id: 'episode_lag',
    hnId: '77',
    status: 'failed',
    failureCode: 'validation_failed',
    failureMessage: 'HackerNewsRadio source metadata must prove an equal, complete expected/fetched comment count.',
    error: 'HackerNewsRadio source metadata must prove an equal, complete expected/fetched comment count.',
    url: 'https://news.ycombinator.com/item?id=77',
    progress: [],
  })

  const batch = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })
  const item = batch.items[0]
  assert.equal(item.attempt, 1, 'index lag is free')
  assert.equal(item.sourceLagHolds, 1)
  assert.equal(h.creates.length, 1, 'it still retries')
  assert.equal(h.settings.get(NIGHTLY_GENERATION_CIRCUIT_KEY)?.state === 'open', false)
})

test('a thread that never converges stops being held and exhausts normally', async () => {
  // The hold is capped so one permanently unreadable story cannot occupy a slot
  // for the whole night.
  const h = harness({ topIds: [] })
  const date = '2026-07-17'
  unsyncedThreadBatch(h, date, { sourceLagHolds: NIGHTLY_MAX_SOURCE_LAG_HOLDS })

  const batch = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })
  const item = batch.items[0]

  assert.equal(item.attempt, 2, 'past the cap it spends attempts like any other failure')
  assert.equal(item.sourceLagHolds, NIGHTLY_MAX_SOURCE_LAG_HOLDS, 'the hold count stops growing')
})

test('an unsynced thread never opens the generation circuit', async () => {
  // One story being briefly unreadable is not the show being broken. Opening
  // the circuit would halt every other story to one probe an hour.
  const h = harness({ topIds: [] })
  const date = '2026-07-17'
  unsyncedThreadBatch(h, date)

  await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })

  assert.equal(h.settings.get(NIGHTLY_GENERATION_CIRCUIT_KEY) ?? null, null)
})

test('a contract failure after a job exists must replan, never resume', () => {
  // The plan already generated (a job only exists once it was approved), so
  // resumeStoryPlan hands back the SAME blueprint — the one the platform just
  // rejected. This is the JOHNSMITH1840 shape: the blueprint cast a speaker the
  // show cannot voice, so every hourly probe replayed the identical rejection
  // and the episode could not recover without a hand-edit to the database.
  const drama = { id: 'e1', jobId: 'job_1', planId: 'plan_1' }
  assert.equal(canResumeGeneration(drama, 'contract'), false)
})

test('a contract failure before job creation still resumes, because that replans', () => {
  // No job means the plan never generated, and resumeStoryPlan resets a
  // non-generated plan to PENDING and re-enqueues it — a genuinely fresh
  // blueprint. Refusing here would throw away a working recovery.
  const drama = { id: 'e1', planId: 'plan_1' }
  assert.equal(canResumeGeneration(drama, 'contract'), true)
})

test('a failure around a sound blueprint resumes as before', () => {
  // provider/quota/transient did not reject the plan, so replanning would just
  // discard a paid one.
  const drama = { id: 'e1', jobId: 'job_1', planId: 'plan_1' }
  for (const cls of ['provider', 'quota', null, undefined]) {
    assert.equal(canResumeGeneration(drama, cls), true, String(cls))
  }
})

test('an episode with nothing to resume is never resumable', () => {
  assert.equal(canResumeGeneration({ id: 'e1' }, null), false)
  assert.equal(canResumeGeneration(null, 'contract'), false)
})

test('a stale batch-item error does not reopen the circuit on a healed episode', async () => {
  // The closed loop that kept HNR down after the cause was already fixed:
  // recoverItem read `item.lastError`, reclassified the old contract message,
  // reopened the circuit, and then denied the slot — so `item.lastError` was
  // never cleared and the next tick read the very same string. The circuit
  // stayed open because it had been open. Hours after the episode itself was
  // healed, it was still reopening on a JOHNSMITH1840 message.
  const h = harness({ topIds: [] })
  const date = '2026-07-17'
  h.dramas.set('episode_healed', {
    id: 'episode_healed',
    hnId: '77',
    status: 'failed',
    // Healed: no failureClass, no error, and nothing left to resume.
    url: 'https://news.ycombinator.com/item?id=77',
    progress: [],
  })
  h.settings.set(nightlyBatchKey(date), {
    date,
    status: 'running',
    target: 5,
    items: [{
      hnId: '77',
      url: 'https://news.ycombinator.com/item?id=77',
      title: 'Story 77',
      episodeId: 'episode_healed',
      workflowId: 'episode_healed',
      attempt: 1,
      recoveryAttempts: 0,
      status: 'blocked',
      lastError: 'Preassigned voiceMap is missing a voice for: JOHNSMITH1840. Supply every speaking character.',
    }],
    errors: [],
  })

  const batch = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })
  const item = batch.items[0]

  assert.equal(h.settings.get(NIGHTLY_GENERATION_CIRCUIT_KEY) ?? null, null,
    'a healed episode must not reopen the circuit')
  assert.equal(item.status, 'queued', 'it retries instead of staying blocked')
  assert.equal(h.creates.length, 1, 'a fresh replacement is queued')
})

test('a failure that never reached an episode still classifies from the item', async () => {
  // The fallback exists for exactly this: reconcileItem threw before any
  // episode row could record it, so the batch item is the only witness.
  const h = harness({ topIds: [] })
  const date = '2026-07-17'
  h.settings.set(nightlyBatchKey(date), {
    date,
    status: 'running',
    target: 5,
    items: [{
      hnId: '77',
      url: 'https://news.ycombinator.com/item?id=77',
      title: 'Story 77',
      episodeId: 'missing_episode',
      workflowId: 'missing_episode',
      attempt: 1,
      recoveryAttempts: 0,
      status: 'failed',
      lastError: 'Planning failed. This request requires more credits, or fewer max_tokens.',
    }],
    errors: [],
  })

  await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })

  const circuit = h.settings.get(NIGHTLY_GENERATION_CIRCUIT_KEY)
  assert.ok(circuit, 'with no episode row, the item is the only signal and must still count')
  assert.equal(circuit.failureClass, 'provider_quota')
})

// ── Readiness preflight (H-B), publish-only recovery (H-A), new classes ─────

function withAlerts(t, h) {
  h.env.RESEND_API_KEY = 'test_resend_key'
  h.env.ALERT_EMAIL = 'ops@example.com'
  const emails = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (_url, options) => {
    emails.push(JSON.parse(options.body))
    return { ok: true, json: async () => ({}) }
  }
  t.after(() => { globalThis.fetch = realFetch })
  return emails
}

function countingSelection(h) {
  const counts = { fetchJson: 0, fetchThread: 0 }
  const fetchJson = h.dependencies.fetchJson
  const fetchThread = h.dependencies.fetchThread
  h.dependencies.fetchJson = async (...args) => { counts.fetchJson++; return fetchJson(...args) }
  h.dependencies.fetchThread = async (...args) => { counts.fetchThread++; return fetchThread(...args) }
  return counts
}

const READY_PUBLISHING = { state: 'granted', code: null, reason: null, grant: { keyId: 'key_hnr', grantedAt: '2026-07-01T00:00:00.000Z' } }
const ALL_MEASURED = ['access', 'project_not_ready', 'cast_not_ready', 'approval_missing', 'quota']
const notReady = (failureClass, extra = {}) => ({
  checked: true,
  ready: false,
  failureClass,
  code: { project_not_ready: 'project_precondition_failed', cast_not_ready: 'cast_precondition_failed', quota: 'insufficient_credits' }[failureClass],
  message: `not ready: ${failureClass}`,
  details: failureClass === 'project_not_ready' ? { stage: 'full_coverage', missingFields: [] } : {},
  measured: ALL_MEASURED,
  balance: 500,
  publishing: READY_PUBLISHING,
  ...extra,
})
const ready = (extra = {}) => ({
  checked: true, ready: true, failureClass: null, measured: ALL_MEASURED, balance: 500, publishing: READY_PUBLISHING, ...extra,
})

for (const [failureClass, subject] of [
  ['project_not_ready', /has not finished a development stage/],
  ['cast_not_ready', /cannot voice a table read/],
  ['quota', /out of Studio Credits/],
]) {
  test(`a ${failureClass} preflight stops the show before anything is fetched, and alerts once`, async (t) => {
    const h = harness({ topIds: [101, 102] })
    const emails = withAlerts(t, h)
    const selection = countingSelection(h)
    let reads = 0
    h.dependencies.readReadiness = async () => { reads++; return notReady(failureClass) }
    const date = '2026-09-29'

    let batch = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })
    assert.equal(reads, 1)
    assert.deepEqual(selection, { fetchJson: 0, fetchThread: 0 }, 'no story is fetched for an episode that cannot start')
    assert.equal(h.creates.length, 0)
    assert.equal(batch.items.length, 0)
    const circuit = h.settings.get(NIGHTLY_GENERATION_CIRCUIT_KEY)
    assert.equal(circuit.failureClass, failureClass)
    assert.equal(emails.length, 1)
    assert.match(emails[0].subject, subject)

    // Within the hour: no read (the circuit is not due), no email.
    h.clock.now = new Date(h.clock.now.getTime() + 10 * 60 * 1000)
    batch = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })
    assert.equal(reads, 1)
    assert.equal(emails.length, 1)

    // The hourly probe is the READ, never an episode — and it does not re-alert.
    h.clock.now = new Date(h.clock.now.getTime() + NIGHTLY_SYSTEMIC_PROBE_COOLDOWN_MS)
    await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })
    assert.equal(reads, 2)
    assert.equal(h.creates.length, 0)
    assert.equal(emails.length, 1, 'one email per outage')
    assert.equal(h.settings.get(NIGHTLY_GENERATION_CIRCUIT_KEY).probeCount, 1)
  })
}

test('a passing read closes a readiness circuit and re-sends the job a 402 refused, under the same key', async () => {
  const h = harness({ topIds: [] })
  const date = '2026-09-29'
  const pendingJob = {
    key: 'episode_q-recovery-run_1-job-r1-j0',
    planId: 'plan_q',
    body: { storyPlanId: 'plan_q', artifactRequests: [{ type: 'table_read' }] },
  }
  h.dramas.set('episode_q', {
    id: 'episode_q',
    hnId: '88',
    status: 'failed',
    failureClass: 'quota',
    failureCode: 'insufficient_credits',
    error: 'Not enough Studio Credits. This job needs 20 credits; you have 4.',
    planId: 'plan_q',
    jobId: 'job_older_take',
    pendingJob,
    url: 'https://news.ycombinator.com/item?id=88',
    progress: [],
  })
  h.settings.set(NIGHTLY_GENERATION_CIRCUIT_KEY, {
    state: 'open',
    probe: 'read',
    failureClass: 'quota',
    failureMessage: 'Not enough Studio Credits.',
    openedAt: '2026-07-16T04:00:00.000Z',
    nextProbeAt: '2026-07-16T05:00:00.000Z',
  })
  h.settings.set(nightlyBatchKey(date), {
    date, status: 'running', target: 5, errors: [],
    items: [{
      hnId: '88', url: 'https://news.ycombinator.com/item?id=88', title: 'Story 88',
      episodeId: 'episode_q', workflowId: 'episode_q', attempt: 2, recoveryAttempts: 0, status: 'blocked',
    }],
  })
  h.dependencies.readReadiness = async () => ready()

  const batch = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })

  assert.equal(h.settings.get(NIGHTLY_GENERATION_CIRCUIT_KEY), null, 'the read closed the circuit')
  assert.equal(h.creates.length, 1)
  assert.deepEqual(h.creates[0].params, {
    dramaId: 'episode_q',
    url: 'https://news.ycombinator.com/item?id=88',
    resumePlanId: 'plan_q',
    jobKey: pendingJob.key,
    recoveryRunId: 'resume_watchdog_1',
  }, 'the refused job is re-sent, not the older take resumed')
  assert.equal(batch.items[0].status, 'queued')
  assert.equal(batch.items[0].attempt, 2, 'an outage never spends an attempt')
  assert.equal(batch.items[0].quotaBlockedAt, undefined, 'a cleared class is not flagged as blocking')
})

test('a preflight that cannot read spends nothing and changes no circuit', async () => {
  const h = harness({ topIds: [101] })
  const selection = countingSelection(h)
  h.dependencies.readReadiness = async () => ({ checked: false, stage: 'credits', error: { message: 'Service Unavailable', status: 503 } })
  const date = '2026-09-29'

  const batch = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })

  assert.equal(h.creates.length, 0)
  assert.equal(selection.fetchThread, 0)
  assert.equal(h.settings.get(NIGHTLY_GENERATION_CIRCUIT_KEY) ?? null, null)
  assert.match(batch.errors.at(-1).message, /Readiness preflight could not read the credits: Service Unavailable/)
})

function heldEpisodeFixture({ item: itemExtra = {}, drama: dramaExtra = {} } = {}) {
  const date = '2026-09-29'
  const drama = {
    id: 'episode_held',
    hnId: '55',
    status: 'ready',
    audioUrl: 'https://files.example/held.mp3',
    artifactId: 'artifact_held',
    publishState: 'blocked',
    publishError: 'The HNR series has no standing approval.',
    url: 'https://news.ycombinator.com/item?id=55',
    title: 'Story 55',
    progress: [{ message: 'Done — your podcast is ready.' }],
    ...dramaExtra,
  }
  const item = {
    hnId: '55', url: drama.url, title: drama.title,
    episodeId: drama.id, workflowId: 'publish_run_0', attempt: 1, recoveryAttempts: 0, status: 'queued',
    ...itemExtra,
  }
  const h = harness({
    settings: new Map([[nightlyBatchKey(date), { date, status: 'running', target: 5, items: [item], errors: [] }]]),
    dramas: new Map([[drama.id, drama]]),
    topIds: [],
  })
  h.workflowStatuses.set('publish_run_0', 'complete')
  return { date, drama, h }
}

test('a finished episode waits for the grant: no workflow while the feed is known to refuse it', async () => {
  const { date, h } = heldEpisodeFixture()
  h.dependencies.readReadiness = async () => ready({
    publishing: { state: 'blocked', code: 'standing_approval_missing', reason: 'The HNR series has no standing approval; grant it.' },
  })

  const batch = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })

  assert.equal(h.creates.length, 0)
  const [item] = batch.items
  assert.equal(item.status, 'publish_blocked')
  assert.match(item.lastError, /no standing approval/)
  assert.equal(item.attempt, 1)
  assert.equal(item.recoveryAttempts, 0)
  assert.equal(batch.failureEvents ?? 0, 0, 'a held episode is not a failure')
})

test('publish-only retries back off instead of running every hour', async () => {
  const { date, h } = heldEpisodeFixture()
  let batch = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })
  assert.equal(h.creates.length, 1)
  assert.equal(h.creates[0].params.publishOnly, true)
  const firstRetryAt = Date.parse(batch.items[0].publishRetryAt)
  assert.equal(firstRetryAt - h.clock.now.getTime(), 60 * 60 * 1000)

  h.workflowStatuses.set(h.creates[0].id, 'complete')
  h.clock.now = new Date(h.clock.now.getTime() + 30 * 60 * 1000)
  batch = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })
  assert.equal(h.creates.length, 1, 'not before the retry time')
  assert.equal(batch.items[0].status, 'publish_blocked')

  h.clock.now = new Date(firstRetryAt + 1)
  batch = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })
  assert.equal(h.creates.length, 2)
  assert.equal(batch.items[0].publishAttempts, 2)
  assert.equal(Date.parse(batch.items[0].publishRetryAt) - h.clock.now.getTime(), 2 * 60 * 60 * 1000)
})

test('a superseded batch keeps draining while it holds a finished, unpublished episode', async () => {
  const { date, h } = heldEpisodeFixture({ item: { status: 'publish_blocked', publishRetryAt: '2026-07-17T00:00:00.000Z' } })
  const batch = await reconcileNightlyBatch(h.env, date, {
    dependencies: h.dependencies, allowGeneration: false, supersededByDate: '2026-09-30',
  })
  assert.equal(batch.items[0].status, 'publish_blocked')
  assert.equal(batch.status, 'draining', 'the episode is not forgotten when its night is over')
})

test('post-production waits while the account is out of credits', async () => {
  const h = harness({ topIds: [] })
  const date = '2026-09-29'
  h.dramas.set('episode_pp', {
    id: 'episode_pp', hnId: '66', status: 'failed', artifactId: 'artifact_pp', audioUrl: null,
    failureClass: 'quota', error: 'Not enough Studio Credits to finalize.',
    url: 'https://news.ycombinator.com/item?id=66', progress: [],
  })
  h.settings.set(NIGHTLY_GENERATION_CIRCUIT_KEY, {
    state: 'open', failureClass: 'quota', failureMessage: 'Not enough Studio Credits.',
    nextProbeAt: '2026-07-16T07:00:00.000Z',
  })
  h.settings.set(nightlyBatchKey(date), {
    date, status: 'running', target: 5, errors: [],
    items: [{ hnId: '66', url: 'https://news.ycombinator.com/item?id=66', title: 'Story 66', episodeId: 'episode_pp', workflowId: 'episode_pp', attempt: 1, recoveryAttempts: 0, status: 'failed' }],
  })

  const batch = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })

  assert.equal(h.creates.length, 0, 'finalize would only buy the same 402')
  assert.equal(batch.items[0].status, 'blocked')
  assert.equal(batch.items[0].recoveryAttempts, 0)
})

test('an episode refused on project state opens a project_not_ready circuit, keeps its attempts, and alerts', async (t) => {
  const h = harness({ topIds: [] })
  const emails = withAlerts(t, h)
  const date = '2026-09-29'
  h.dramas.set('episode_gate', {
    id: 'episode_gate', hnId: '77', status: 'failed',
    failureCode: 'project_precondition_failed',
    failureMessage: 'Pass full Series Bible coverage before starting episodes, project videos, or publishing.',
    url: 'https://news.ycombinator.com/item?id=77', progress: [],
  })
  h.settings.set(nightlyBatchKey(date), {
    date, status: 'running', target: 5, errors: [],
    items: [{ hnId: '77', url: 'https://news.ycombinator.com/item?id=77', title: 'Story 77', episodeId: 'episode_gate', workflowId: 'episode_gate', attempt: 3, recoveryAttempts: 0, status: 'failed' }],
  })

  const batch = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })

  assert.equal(batch.items[0].status, 'blocked')
  assert.equal(batch.items[0].attempt, 3, 'state is not an attempt')
  assert.ok(batch.items[0].projectBlockedAt)
  assert.equal(h.settings.get(NIGHTLY_GENERATION_CIRCUIT_KEY).failureClass, 'project_not_ready')
  assert.equal(h.creates.length, 0)
  assert.equal(emails.length, 1)
  assert.match(emails[0].subject, /has not finished a development stage/)
})

test('only an attempt that failed before any plan may recapture its source', async () => {
  const h = harness({ topIds: [] })
  const date = '2026-09-29'
  h.dramas.set('episode_early', {
    id: 'episode_early', hnId: '77', status: 'failed', commentCount: 20,
    error: 'Table-read script generation produced empty output.',
    url: 'https://news.ycombinator.com/item?id=77', progress: [],
  })
  h.settings.set(nightlyBatchKey(date), {
    date, status: 'running', target: 5, errors: [],
    items: [
      { hnId: '77', url: 'https://news.ycombinator.com/item?id=77', title: 'Story 77', episodeId: 'episode_early', workflowId: 'episode_early', attempt: 1, recoveryAttempts: 0, status: 'failed' },
    ],
  })

  await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })
  assert.equal(h.creates.length, 1)
  assert.deepEqual(h.creates[0].params.sourceRecapture, { previousCommentCount: 20 })
})

test('an attempt that failed after its plan never recaptures (the plan read that source)', async () => {
  const h = harness({ topIds: [] })
  const date = '2026-09-29'
  // A contract failure after a job exists replans from scratch — a replacement
  // — but a plan already consumed the capture, so it is reused, not replaced.
  h.dramas.set('episode_late', {
    id: 'episode_late', hnId: '78', status: 'failed', commentCount: 20, planId: 'plan_late', jobId: 'job_late',
    failureClass: 'contract', error: '`creativeBrief` is invalid: Too big',
    url: 'https://news.ycombinator.com/item?id=78', progress: [],
  })
  h.settings.set(NIGHTLY_GENERATION_CIRCUIT_KEY, {
    state: 'open', failureClass: 'contract', failureMessage: 'x', nextProbeAt: '2026-07-16T05:00:00.000Z',
  })
  h.settings.set(nightlyBatchKey(date), {
    date, status: 'running', target: 5, errors: [],
    items: [
      { hnId: '78', url: 'https://news.ycombinator.com/item?id=78', title: 'Story 78', episodeId: 'episode_late', workflowId: 'episode_late', attempt: 1, recoveryAttempts: 0, status: 'failed' },
    ],
  })

  await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })
  assert.equal(h.creates.length, 1, 'the due contract probe replans')
  assert.equal(h.creates[0].params.sourceRecapture, undefined)
})

test('a held episode stops keeping its night alive after the hold window', async () => {
  const { date, h } = heldEpisodeFixture({ item: { status: 'publish_blocked', publishRetryAt: '2026-12-31T00:00:00.000Z' } })
  h.clock.now = new Date('2026-10-14T00:00:00.000Z')
  const batch = await reconcileNightlyBatch(h.env, date, {
    dependencies: h.dependencies, allowGeneration: false, supersededByDate: '2026-10-13',
  })
  assert.equal(batch.items[0].status, 'publish_blocked')
  assert.equal(batch.status, 'superseded', 'old nights are not walked forever while the feed is blocked')
  assert.equal(h.creates.length, 0)
})

// ── The preflight through the REAL readReadiness, against a fake Story API ──
//
// These drive `readReadiness` itself (not a stub of its result), so they hold
// the nightly to what the platform actually answers.

const HNR_KEY_ID = 'key_hnr'
const SERIES_ID = 'series_hnr'
const PASSING_GATE = { ready: true, stage: 'ready', reason: null, missingFields: [], canPlan: true, canStartEpisode: true }
const GRANTED_SERIES = {
  id: SERIES_ID,
  status: 'active',
  medium: 'audio',
  standingApproval: { keyId: HNR_KEY_ID, keyName: 'HNR', keyStart: 'sh_hn', grantedAt: '2026-07-01T00:00:00.000Z', grantedBy: 'owner' },
}

/** A live, mutable platform: flip its fields between ticks. */
function platform(h, overrides = {}) {
  const state = {
    project: { id: 'p', workspaceGate: PASSING_GATE },
    credits: { balance: 500 },
    series: GRANTED_SERIES,
    projectError: null,
    seriesError: null,
    reads: [],
    ...overrides,
  }
  h.settings.set('publishingSeriesId', SERIES_ID)
  h.dependencies.readReadiness = async (_env, { seriesId, minCredits } = {}) => {
    state.reads.push({ seriesId, minCredits })
    return readReadiness({
      async getProject() {
        if (state.projectError) throw state.projectError
        return state.project
      },
      async getCredits() { return state.credits },
      async getPublishingSeries() {
        if (state.seriesError) throw state.seriesError
        return state.series
      },
    }, { projectId: 'p', seriesId, keyId: HNR_KEY_ID, minCredits })
  }
  return state
}

const hour = (h, n = 1) => { h.clock.now = new Date(h.clock.now.getTime() + n * NIGHTLY_SYSTEMIC_PROBE_COOLDOWN_MS) }

// MUST FIX 1: the grant gates SPENDING, not just publishing.
for (const [label, series, seriesError, code] of [
  ['revoked (the platform reports null)', { ...GRANTED_SERIES, standingApproval: null }, null, 'standing_approval_missing'],
  ['bound to another key', { ...GRANTED_SERIES, standingApproval: { ...GRANTED_SERIES.standingApproval, keyId: 'key_other' } }, null, 'standing_approval_other_key'],
  ['not reported by the platform', { id: SERIES_ID, status: 'active', medium: 'audio' }, null, 'standing_approval_unavailable'],
  ['unreadable (403)', null, new SleeperHitError('Missing publishing:read', { status: 403, code: 'insufficient_scope' }), 'standing_approval_unreadable'],
]) {
  test(`a grant that is ${label} starts no episode Workflow, opens the circuit, and alerts once`, async (t) => {
    const h = harness({ topIds: [101, 102] })
    const emails = withAlerts(t, h)
    const selection = countingSelection(h)
    platform(h, { series, seriesError })
    const date = '2026-09-29'

    for (let tick = 0; tick < 4; tick++) {
      await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })
      hour(h)
    }

    assert.equal(h.creates.length, 0, 'no episode Workflow: nothing is uploaded, planned, approved or bought')
    assert.deepEqual(selection, { fetchJson: 0, fetchThread: 0 })
    const circuit = h.settings.get(NIGHTLY_GENERATION_CIRCUIT_KEY)
    assert.equal(circuit.failureClass, 'approval_missing')
    assert.equal(circuit.failureCode, code)
    assert.equal(circuit.probe, 'read')
    assert.equal(emails.length, 1, 'one email per outage')
    assert.match(emails[0].subject, /no standing approval/)
  })
}

test('a readiness result that is ready but reports no grant is still not permission to spend', async (t) => {
  const h = harness({ topIds: [101] })
  const emails = withAlerts(t, h)
  h.dependencies.readReadiness = async () => ready({
    publishing: { state: 'blocked', code: 'standing_approval_missing', reason: 'The HNR series has no standing approval.' },
  })
  await reconcileNightlyBatch(h.env, '2026-09-29', { dependencies: h.dependencies })
  assert.equal(h.creates.length, 0)
  assert.equal(h.settings.get(NIGHTLY_GENERATION_CIRCUIT_KEY).failureClass, 'approval_missing')
  assert.equal(emails.length, 1)
})

test('a re-grant closes the approval circuit on the next read and the show resumes', async () => {
  const h = harness({ topIds: [101] })
  const api = platform(h, { series: { ...GRANTED_SERIES, standingApproval: null } })
  const date = '2026-09-29'
  await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })
  assert.equal(h.creates.length, 0)

  api.series = GRANTED_SERIES
  hour(h)
  await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })
  assert.equal(h.settings.get(NIGHTLY_GENERATION_CIRCUIT_KEY), null)
  assert.equal(h.creates.length, 1, 'one serialized episode starts')
})

// MUST FIX 2: a passing read clears only what it measures, and only a failure
// it saw after the episode failed.

function failedEpisodeBatch(h, date, drama, itemExtra = {}) {
  h.dramas.set(drama.id, {
    hnId: '77', status: 'failed', url: 'https://news.ycombinator.com/item?id=77', progress: [], ...drama,
  })
  h.settings.set(nightlyBatchKey(date), {
    date, status: 'running', target: 5, errors: [],
    items: [{
      hnId: '77', url: 'https://news.ycombinator.com/item?id=77', title: 'Story 77',
      episodeId: drama.id, workflowId: drama.id, attempt: 1, recoveryAttempts: 0, status: 'failed', ...itemExtra,
    }],
  })
  h.workflowStatuses.set(drama.id, 'errored')
}

/** Re-fail whatever Workflow the nightly just started for the episode. */
function failAgain(h, dramaId, patch) {
  const created = h.creates.at(-1)
  if (created) h.workflowStatuses.set(created.id, 'errored')
  h.dramas.set(dramaId, { ...h.dramas.get(dramaId), status: 'failed', ...patch, failedAt: h.clock.now.toISOString() })
}

for (const [label, drama, blockedAt, subject, expectedClass] of [
  ['a cast refusal the read cannot measure (no tableReadReadiness)', {
    failureCode: 'cast_precondition_failed',
    failureMessage: 'Finalize the episode screenplay and complete its Cast before starting Table Read.',
    planId: 'plan_77',
  }, 'castBlockedAt', /cannot voice a table read/, 'cast_not_ready'],
  ['a provider quota cliff the credit read cannot see', {
    failureMessage: 'You exceeded your current quota, please check your plan and billing details.',
    jobId: 'job_77', planId: 'plan_77',
  }, 'providerQuotaBlockedAt', /provider quota cliff/, 'provider_quota'],
]) {
  test(`${label} reaches a circuit and an alert, never an hourly resume loop`, async (t) => {
    const h = harness({ topIds: [] })
    const emails = withAlerts(t, h)
    platform(h)
    const date = '2026-09-29'
    failedEpisodeBatch(h, date, { id: 'episode_77', failedAt: '2026-07-16T05:30:00.000Z', ...drama })

    let batch = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })
    assert.equal(h.creates.length, 0, 'the read passed, but it cannot vouch for this failure')
    assert.equal(batch.items[0].status, 'blocked')
    assert.ok(batch.items[0][blockedAt])
    const circuit = h.settings.get(NIGHTLY_GENERATION_CIRCUIT_KEY)
    assert.equal(circuit.failureClass, expectedClass)
    assert.equal(circuit.probe, 'episode', 'probed by resuming the stopped episode, never by the read')
    assert.equal(emails.length, 1)
    assert.match(emails[0].subject, subject)

    // Four hours of the same refusal: the probe is rate-limited, the circuit
    // stays open, and the operator is not re-emailed.
    for (let tick = 0; tick < 4; tick++) {
      hour(h)
      batch = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })
      failAgain(h, 'episode_77', drama)
    }
    assert.equal(h.creates.length, 2, 'one probe, then a full window after each failed probe (5 ticks, 2 probes)')
    assert.ok(h.settings.get(NIGHTLY_GENERATION_CIRCUIT_KEY), 'the circuit is still open')
    assert.equal(batch.items[0].attempt, 1, 'a systemic block does not spend attempts')
    assert.equal(emails.length, 1)
  })
}

test('a 402 that needs more than one typical episode waits for THAT balance, and says so', async (t) => {
  const h = harness({ topIds: [] })
  const emails = withAlerts(t, h)
  const api = platform(h, { credits: { balance: 28 } })
  const date = '2026-09-29'
  const pendingJob = { key: 'episode_q-job-r1-j0', planId: 'plan_q', body: { storyPlanId: 'plan_q' }, required: 30 }
  failedEpisodeBatch(h, date, {
    id: 'episode_q', failureClass: 'quota', failureCode: 'insufficient_credits',
    failureMessage: 'Not enough Studio Credits to start this job (need 30, have 4).',
    planId: 'plan_q', pendingJob, failedAt: '2026-07-16T05:00:00.000Z',
  })

  let batch = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })
  assert.equal(h.creates.length, 0, '28 covers a typical episode, not this job')
  let circuit = h.settings.get(NIGHTLY_GENERATION_CIRCUIT_KEY)
  assert.equal(circuit.failureClass, 'quota')
  assert.equal(circuit.probe, 'read')
  assert.deepEqual(circuit.readiness.details, { balance: 28, required: 30 })
  assert.equal(emails.length, 1)
  assert.match(emails[0].subject, /out of Studio Credits/)
  assert.ok(emails[0].text.includes('Balance: 28 (an episode needs 30).'))

  for (let tick = 0; tick < 3; tick++) {
    hour(h)
    batch = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })
  }
  assert.equal(h.creates.length, 0)
  assert.deepEqual(api.reads.slice(1).map((read) => read.minCredits), [30, 30, 30], 'the read waits for the job\'s price')
  assert.equal(emails.length, 1)
  assert.equal(batch.items[0].attempt, 1)

  api.credits = { balance: 40 }
  hour(h)
  batch = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })
  assert.equal(h.settings.get(NIGHTLY_GENERATION_CIRCUIT_KEY), null)
  assert.equal(h.creates.length, 1)
  assert.equal(h.creates[0].params.jobKey, pendingJob.key, 'the same job request, re-sent')
})

test('a condition the read SAW failing after the episode failed is cleared by the passing read, spending nothing', async () => {
  const h = harness({ topIds: [] })
  const api = platform(h, { project: { id: 'p', workspaceGate: { ...PASSING_GATE, ready: false, canStartEpisode: false, stage: 'full_coverage' } } })
  const date = '2026-09-29'
  failedEpisodeBatch(h, date, {
    id: 'episode_gate', failureCode: 'project_precondition_failed',
    failureMessage: 'Pass full Series Bible coverage before starting episodes.',
    planId: 'plan_gate', failedAt: '2026-07-16T05:30:00.000Z',
  })

  await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })
  assert.equal(h.settings.get(NIGHTLY_GENERATION_CIRCUIT_KEY).probe, 'read')

  api.project = { id: 'p', workspaceGate: PASSING_GATE }
  hour(h)
  const batch = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })
  assert.equal(h.settings.get(NIGHTLY_GENERATION_CIRCUIT_KEY), null)
  assert.equal(h.creates.length, 1)
  assert.equal(h.creates[0].params.resumePlanId, 'plan_gate')
  assert.equal(batch.items[0].attempt, 1, 'an outage never spends an attempt')
  assert.equal(batch.items[0].projectBlockedAt, undefined)
})

test('a measured condition that failed AFTER a passing read is not cleared by the next one', async (t) => {
  // The read said the gate was open, the episode started, and the platform
  // refused it on the gate anyway. Another passing read proves nothing.
  const h = harness({ topIds: [] })
  const emails = withAlerts(t, h)
  platform(h)
  const date = '2026-09-29'
  failedEpisodeBatch(h, date, {
    id: 'episode_gate', failureCode: 'project_precondition_failed',
    failureMessage: 'Pass full Series Bible coverage before starting episodes.',
    planId: 'plan_gate', failedAt: '2026-07-16T05:30:00.000Z',
  })

  const batch = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })
  assert.equal(h.creates.length, 0)
  assert.equal(batch.items[0].status, 'blocked')
  const circuit = h.settings.get(NIGHTLY_GENERATION_CIRCUIT_KEY)
  assert.equal(circuit.failureClass, 'project_not_ready')
  assert.equal(circuit.probe, 'episode')
  assert.equal(emails.length, 1)
})

test('a cast refusal the read measured as ready is this plan\'s roster: it spends the attempt and re-plans', async () => {
  const h = harness({ topIds: [] })
  platform(h, {
    project: {
      id: 'p',
      workspaceGate: PASSING_GATE,
      tableReadReadiness: { ready: true, audioOnly: true, reason: 'ready', narratorVoice: false, members: [] },
    },
  })
  const date = '2026-09-29'
  failedEpisodeBatch(h, date, {
    id: 'episode_guest', failureCode: 'cast_precondition_failed',
    failureMessage: 'A speaker the cast does not cover: HN_COMMENTER.',
    planId: 'plan_guest', jobId: 'job_guest', failedAt: '2026-07-16T05:30:00.000Z',
  })

  const batch = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })
  assert.equal(h.settings.get(NIGHTLY_GENERATION_CIRCUIT_KEY) ?? null, null, 'the project is fine; the show is not stopped')
  assert.equal(h.creates.length, 1)
  assert.equal(h.creates[0].params.resumePlanId, undefined, 'the same plan would be refused again')
  assert.equal(h.creates[0].params.resumeJobId, undefined)
  assert.equal(batch.items[0].attempt, 2, 'a per-episode failure spends its attempt, so it is bounded')
})

// MUST FIX 3: a refused read is an outage with a name, not a silent skip.

test('a 401 on the preflight opens an access circuit, alerts exactly once, and a passing read closes it', async (t) => {
  const h = harness({ topIds: [101] })
  const emails = withAlerts(t, h)
  const api = platform(h, { projectError: new SleeperHitError('API key revoked.', { status: 401, code: 'api_key_revoked' }) })

  const dates = ['2026-09-29', '2026-09-30']
  for (const date of dates) {
    for (let tick = 0; tick < 24; tick++) {
      await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })
      hour(h)
    }
  }
  assert.equal(h.creates.length, 0)
  const circuit = h.settings.get(NIGHTLY_GENERATION_CIRCUIT_KEY)
  assert.equal(circuit.failureClass, 'access')
  assert.equal(circuit.failureCode, 'api_key_revoked')
  assert.equal(circuit.probe, 'read')
  assert.equal(emails.length, 1, 'one email for the whole outage, across batch dates')
  assert.match(emails[0].subject, /refuses HNR's key or project/)
  assert.ok(emails[0].text.includes('Refused read: project (401 api_key_revoked).'))

  api.projectError = null
  await reconcileNightlyBatch(h.env, '2026-09-30', { dependencies: h.dependencies })
  assert.equal(h.settings.get(NIGHTLY_GENERATION_CIRCUIT_KEY), null)
  assert.equal(h.creates.length, 1, 'the show resumes')
})

test('a 5xx on the preflight still only skips the tick', async () => {
  const h = harness({ topIds: [101] })
  platform(h, { projectError: new SleeperHitError('Bad Gateway', { status: 502 }) })
  const batch = await reconcileNightlyBatch(h.env, '2026-09-29', { dependencies: h.dependencies })
  assert.equal(h.creates.length, 0)
  assert.equal(h.settings.get(NIGHTLY_GENERATION_CIRCUIT_KEY) ?? null, null)
  assert.match(batch.errors.at(-1).message, /could not read the project: Bad Gateway/)
})

test('a preflight reported as unreadable with a refusal status is still an access outage, never a silent skip', async (t) => {
  const h = harness({ topIds: [101] })
  const emails = withAlerts(t, h)
  h.dependencies.readReadiness = async () => ({ checked: false, stage: 'project', error: { message: 'Unauthorized', status: 401 } })
  for (let tick = 0; tick < 48; tick++) {
    await reconcileNightlyBatch(h.env, tick < 24 ? '2026-09-29' : '2026-09-30', { dependencies: h.dependencies })
    hour(h)
  }
  assert.equal(h.creates.length, 0)
  const circuit = h.settings.get(NIGHTLY_GENERATION_CIRCUIT_KEY)
  assert.equal(circuit.failureClass, 'access')
  assert.equal(circuit.failureCode, 'http_401')
  assert.equal(emails.length, 1)
})


// ── The preflight heals the cast canon from HNR's OWN pinned voices ──────────
//
// Through the PRODUCTION path: the default readShowReadiness, the real
// SleeperHit client, the D1 `pinnedVoices` setting, and a fake Story API over
// fetch whose project reports a table read ready exactly when the canon voices
// every member. The only code that wrote the canon used to be the pipeline,
// which never runs while the preflight says `cast_not_ready`: a deadlock.

const CANON_API = 'https://api.canon.test'
const CANON_PROJECT = 'project_hnr'
const HOST_NAMES = ['GARY', 'MAEVE', 'OBI', 'GRUNER']
const PINNED_HOSTS = {
  GARY: { voiceId: 'v_gary', voiceName: 'Gary', provider: 'elevenlabs' },
  MAEVE: { voiceId: 'v_maeve', voiceName: 'Maeve', provider: 'elevenlabs' },
  OBI: { voiceId: 'v_obi', voiceName: 'Obi', provider: 'elevenlabs' },
  GRUNER: { voiceId: 'v_gruner', voiceName: 'Gruner', provider: 'hume' },
}
const avatar = (name) => `https://hnradio.net/avatars/${name.toLowerCase()}.png`
const facesOnlyCanon = () => ({
  content: { characters: HOST_NAMES.map((name) => ({ name, avatarUrl: avatar(name), bodyFigureUrl: `https://files.example/${name}.png` })) },
})
const voicedCanon = () => ({
  content: {
    characters: HOST_NAMES.map((name) => ({
      name, avatarUrl: avatar(name), voiceId: PINNED_HOSTS[name].voiceId, voiceProvider: PINNED_HOSTS[name].provider,
    })),
  },
})

/** A D1 whose settings table is the harness's settings map (what store.getSetting reads). */
function settingsD1(settings) {
  return {
    prepare(sql) {
      return {
        bind(key) {
          return {
            async first() {
              if (!/^SELECT value FROM settings/.test(sql.trim())) throw new Error(`Unexpected D1 read: ${sql}`)
              return settings.has(key) ? { value: JSON.stringify(settings.get(key)) } : null
            },
          }
        },
      }
    },
  }
}

function canonStoryApi(t, h, { pinned = PINNED_HOSTS, canon = facesOnlyCanon(), extraMembers = [], patchRefusal = null } = {}) {
  const api = { canon, requests: [], emails: [] }
  Object.assign(h.env, {
    DB: settingsD1(h.settings),
    SLEEPERHIT_API_BASE: CANON_API,
    SLEEPERHIT_API_KEY: 'sh_test_key',
    SLEEPERHIT_API_KEY_ID: HNR_KEY_ID,
    HNRADIO_PROJECT_ID: CANON_PROJECT,
    RESEND_API_KEY: 'test_resend_key',
    ALERT_EMAIL: 'ops@example.com',
  })
  if (pinned) h.settings.set('pinnedVoices', pinned)
  h.settings.set('publishingSeriesId', SERIES_ID)

  const tableReadReadiness = () => {
    const characters = api.canon?.content?.characters ?? []
    const members = [
      ...HOST_NAMES.map((name) => {
        const ready = Boolean(characters.find((character) => character.name === name)?.voiceId)
        return { name, narrator: false, ready, missing: ready ? [] : ['voice'] }
      }),
      ...extraMembers,
    ]
    const unvoiced = members.filter((member) => !member.ready).map((member) => member.name)
    return {
      ready: unvoiced.length === 0,
      audioOnly: true,
      narratorVoice: false,
      reason: unvoiced.length ? `${unvoiced.join(', ')} has no voice in the cast canon.` : null,
      members,
    }
  }
  const respond = (status, payload) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) })
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url)
    const body = options.body ? JSON.parse(options.body) : undefined
    if (target.startsWith('https://api.resend.com/')) {
      api.emails.push(body)
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' }
    }
    const method = options.method || 'GET'
    const path = target.replace(`${CANON_API}/api/v1`, '')
    api.requests.push({ method, path, body })
    if (method === 'GET' && path === `/story-projects/${CANON_PROJECT}`) {
      return respond(200, { project: { id: CANON_PROJECT, workspaceGate: PASSING_GATE, tableReadReadiness: tableReadReadiness() } })
    }
    if (method === 'GET' && path === '/credits') return respond(200, { credits: { balance: 500 } })
    if (method === 'GET' && path === `/publishing-series/${SERIES_ID}`) return respond(200, { series: GRANTED_SERIES })
    if (method === 'GET' && path === `/story-projects/${CANON_PROJECT}/cast-canon`) return respond(200, { canon: api.canon })
    if (method === 'PATCH' && path === `/story-projects/${CANON_PROJECT}/cast-canon`) {
      if (patchRefusal) return respond(patchRefusal.status, { error: { code: patchRefusal.code, message: patchRefusal.message } })
      // Merge-patch: each character merges field-by-field onto the person of the same name.
      const characters = [...(api.canon?.content?.characters ?? [])]
      for (const patch of body.content.characters) {
        const index = characters.findIndex((character) => character.name === patch.name)
        if (index === -1) characters.push(patch)
        else characters[index] = { ...characters[index], ...patch }
      }
      api.canon = { ...(api.canon ?? {}), content: { ...(api.canon?.content ?? {}), characters } }
      return respond(200, { canon: api.canon })
    }
    throw new Error(`unexpected ${method} ${path}`)
  }
  t.after(() => { globalThis.fetch = realFetch })
  return api
}

const canonCalls = (api) => api.requests.filter((request) => request.path.endsWith('/cast-canon'))
const projectReads = (api) => api.requests.filter((request) => request.method === 'GET' && request.path === `/story-projects/${CANON_PROJECT}`)

test('a canon missing voices HNR has pinned is pushed before the cast is judged, re-read, and the show goes on', async (t) => {
  const h = harness({ topIds: [101] })
  const api = canonStoryApi(t, h)
  const date = '2026-09-29'

  await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })

  const patches = api.requests.filter((request) => request.method === 'PATCH')
  assert.equal(patches.length, 1)
  assert.deepEqual(patches[0].body, {
    content: {
      characters: [
        { name: 'GARY', avatarUrl: avatar('GARY'), voiceId: 'v_gary', voiceProvider: 'elevenlabs' },
        { name: 'MAEVE', avatarUrl: avatar('MAEVE'), voiceId: 'v_maeve', voiceProvider: 'elevenlabs' },
        { name: 'OBI', avatarUrl: avatar('OBI'), voiceId: 'v_obi', voiceProvider: 'elevenlabs' },
        { name: 'GRUNER', avatarUrl: avatar('GRUNER'), voiceId: 'v_gruner', voiceProvider: 'hume' },
      ],
    },
  }, 'exactly what castCanonCharacters builds from the D1 pinnedVoices, under content.characters')
  assert.deepEqual(api.requests.map((request) => `${request.method} ${request.path}`), [
    `GET /story-projects/${CANON_PROJECT}`,
    'GET /credits',
    `GET /publishing-series/${SERIES_ID}`,
    `GET /story-projects/${CANON_PROJECT}/cast-canon`,
    `PATCH /story-projects/${CANON_PROJECT}/cast-canon`,
    `GET /story-projects/${CANON_PROJECT}`,
  ], 'the project is re-read after the push, so the verdict judges the canon HNR just wrote')
  assert.equal(h.settings.get(NIGHTLY_GENERATION_CIRCUIT_KEY) ?? null, null, 'no cast circuit')
  assert.equal(h.creates.length, 1, 'the tick proceeds to its one serialized episode')
  assert.equal(api.emails.length, 0, 'nothing for the operator to do')

  // A healthy cast costs the preflight nothing extra: no canon call at all.
  hour(h)
  await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })
  assert.equal(canonCalls(api).length, 2)
  assert.equal(projectReads(api).length, 3)
})

test('a host with no pinned voice is never invented: its voice is not pushed and the cast stays cast_not_ready', async (t) => {
  const h = harness({ topIds: [101] })
  const { GRUNER: _unpinned, ...threeHosts } = PINNED_HOSTS
  const api = canonStoryApi(t, h, { pinned: threeHosts })

  await reconcileNightlyBatch(h.env, '2026-09-29', { dependencies: h.dependencies })

  const pushed = api.requests.filter((request) => request.method === 'PATCH').flatMap((request) => request.body.content.characters)
  assert.deepEqual(pushed.map((character) => character.name), ['GARY', 'MAEVE', 'OBI'])
  assert.equal(pushed.some((character) => character.name === 'GRUNER'), false, 'no voice is invented for GRUNER')
  assert.equal(api.canon.content.characters.find((character) => character.name === 'GRUNER').voiceId, undefined)
  assert.equal(projectReads(api).length, 2, 'the push wrote something, so the verdict is re-read')

  const circuit = h.settings.get(NIGHTLY_GENERATION_CIRCUIT_KEY)
  assert.equal(circuit.failureClass, 'cast_not_ready')
  assert.equal(circuit.failureCode, 'cast_precondition_failed')
  assert.deepEqual(circuit.readiness.details.missing, ['GRUNER (voice)'])
  assert.equal(h.creates.length, 0)
  assert.equal(api.emails.length, 1)
  assert.match(api.emails[0].subject, /cannot voice a table read/)
  assert.match(api.emails[0].text, /Unvoiced: GRUNER \(voice\)/)
  assert.match(api.emails[0].text, /Pin the voice in the cast canon/)
})

test('a canon push the Story API refuses is a cast_not_ready failure that names the refusal, never swallowed', async (t) => {
  const h = harness({ topIds: [101] })
  const api = canonStoryApi(t, h, {
    patchRefusal: { status: 400, code: 'invalid_request', message: 'content.characters[0]: Unrecognized key "voiceProvider"' },
  })

  await reconcileNightlyBatch(h.env, '2026-09-29', { dependencies: h.dependencies })

  assert.equal(api.requests.filter((request) => request.method === 'PATCH').length, 1)
  assert.equal(projectReads(api).length, 1, 'nothing was written, so there is nothing to re-read')
  const circuit = h.settings.get(NIGHTLY_GENERATION_CIRCUIT_KEY)
  assert.equal(circuit.failureClass, 'cast_not_ready')
  assert.equal(circuit.failureCode, 'cast_canon_sync_refused')
  assert.match(circuit.failureMessage,
    /refused HNR's push of its pinned host voices to the cast canon \(400 invalid_request\): content\.characters\[0\]: Unrecognized key "voiceProvider"/)
  assert.deepEqual(circuit.readiness.details.canonSync, { status: 400, code: 'invalid_request' })
  assert.equal(classifySystemicFailure({ failureCode: circuit.failureCode }), 'cast_not_ready')
  assert.equal(h.creates.length, 0)
  assert.equal(api.emails.length, 1, 'the operator is told once')
  assert.match(api.emails[0].text, /400 invalid_request/)
})

test('while the deploy gate is locked the tick makes no canon call at all', async (t) => {
  const now = '2026-09-30T00:30:00.000Z'
  const h = harness({ now, topIds: [101] })
  const api = canonStoryApi(t, h)
  h.settings.set(WORKFLOW_DEPLOY_GATE_KEY, { state: 'locked', runId: '123', expiresAt: '2026-09-30T01:00:00.000Z' })

  const batches = await runNightlyReconciliation(h.env, { now: new Date(now), dependencies: h.dependencies })

  assert.deepEqual(batches, [])
  assert.deepEqual(api.requests, [], 'no read, no canon GET, no PATCH')
  assert.equal(api.canon.content.characters[0].voiceId, undefined)

  // Once the lock expires the same tick heals the canon.
  h.settings.set(WORKFLOW_DEPLOY_GATE_KEY, { state: 'released' })
  await runNightlyReconciliation(h.env, { now: new Date(now), dependencies: h.dependencies })
  assert.equal(api.requests.filter((request) => request.method === 'PATCH').length, 1)
})

test('a canon that already carries every pinned voice is read, never written', async (t) => {
  const h = harness({ topIds: [101] })
  // The platform still refuses the read for a member HNR does not pin.
  const api = canonStoryApi(t, h, {
    canon: voicedCanon(),
    extraMembers: [{ name: 'CALLER', narrator: false, ready: false, missing: ['voice'] }],
  })

  await reconcileNightlyBatch(h.env, '2026-09-29', { dependencies: h.dependencies })

  assert.deepEqual(canonCalls(api).map((request) => request.method), ['GET'], 'one GET, no PATCH')
  assert.equal(projectReads(api).length, 1, 'nothing was written, so no re-read')
  const circuit = h.settings.get(NIGHTLY_GENERATION_CIRCUIT_KEY)
  assert.equal(circuit.failureClass, 'cast_not_ready')
  assert.deepEqual(circuit.readiness.details.missing, ['CALLER (voice)'])
  assert.equal(h.creates.length, 0)
})
