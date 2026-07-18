import test from 'node:test'
import assert from 'node:assert/strict'

import {
  NIGHTLY_MUSIC_RECOVERY_COOLDOWN_MS,
  NIGHTLY_MUSIC_RECOVERY_MAX_ACTIONS,
  NIGHTLY_MUSIC_STALL_TIMEOUT_MS,
  PUBLISHED_PROGRESS_MESSAGE,
  centralRunContext,
  hasPublishedProgress,
  isActiveWorkflowStatus,
  isPublishedEpisode,
  nightlyBatchKey,
  reconcileNightlyBatch,
  runNightlyReconciliation,
} from '../worker/nightly.mjs'

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

test('a quota-class failure retries the same story without consuming attempts', async () => {
  const h = harness({ topIds: [] })
  const date = '2026-07-17'
  h.dramas.set('episode_quota', {
    id: 'episode_quota',
    hnId: '77',
    status: 'failed',
    error: 'You have reached your specified API usage limits. You will regain access on 2026-08-01 at 00:00 UTC.',
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

  const batch = await reconcileNightlyBatch(h.env, date, { dependencies: h.dependencies })
  const item = batch.items[0]
  assert.equal(item.status, 'queued')
  assert.equal(item.attempt, 3, 'quota failures must not consume the attempt budget')
  assert.ok(item.quotaBlockedAt)
  assert.equal(h.creates.length, 1, 'the same story is retried')
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
  assert.match(emails[0].body.subject, /quota cliff/)
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
