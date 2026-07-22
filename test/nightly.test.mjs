import test from 'node:test'
import assert from 'node:assert/strict'

import {
  NIGHTLY_GENERATION_CIRCUIT_KEY,
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

test('a quota-class failure opens the circuit, then retries the same job on the hourly probe', async () => {
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
  assert.ok(item.quotaBlockedAt)
  assert.equal(h.creates.length, 0, 'opening the circuit does not fan out immediately')
  assert.equal(h.settings.get(NIGHTLY_GENERATION_CIRCUIT_KEY).failureClass, 'quota')

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
  assert.equal(h.creates[0].params.resumeArtifactId, episode.artifactId)
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
