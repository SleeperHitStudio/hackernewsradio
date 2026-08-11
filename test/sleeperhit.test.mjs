import test from 'node:test'
import assert from 'node:assert/strict'

import {
  STORY_JOB_POLL_ATTEMPTS,
  STORY_JOB_POLL_INTERVAL_MS,
  SleeperHit,
  summarizeVoiceModifications,
} from '../worker/sleeperhit.mjs'

test('Sleeper client StoryJob polling budget is at least 60 minutes', () => {
  assert.ok(STORY_JOB_POLL_ATTEMPTS * STORY_JOB_POLL_INTERVAL_MS >= 60 * 60 * 1000)
})

test('text source uploads preserve the full-context policy and completeness proof', async () => {
  const client = new SleeperHit({ baseUrl: 'https://example.test', apiKey: 'test' })
  const calls = []
  client.request = async (path, options) => {
    calls.push({ path, options })
    return { source: { id: 'source_1' } }
  }
  const metadata = {
    sourceProducer: 'hackernewsradio',
    sourceContextMode: 'full',
    sourceCompleteness: { comments: { complete: true, expected: 2, fetched: 2 } },
  }

  const sourceId = await client.addTextSource('project_1', {
    content: 'ARTICLE-END\nCOMMENT-END',
    label: 'HN thread 42',
    metadata,
    idempotencyKey: 'episode-source',
  })

  assert.equal(sourceId, 'source_1')
  assert.deepEqual(calls, [{
    path: '/story-projects/project_1/sources',
    options: {
      method: 'POST',
      idempotencyKey: 'episode-source',
      body: {
        type: 'text',
        content: 'ARTICLE-END\nCOMMENT-END',
        label: 'HN thread 42',
        metadata,
      },
    },
  }])
})

test('plan and job recovery call the same-resource resume endpoints with stable keys', async () => {
  const client = new SleeperHit({ baseUrl: 'https://example.test', apiKey: 'test' })
  const calls = []
  client.request = async (path, options = {}) => {
    calls.push({ path, options })
    return path.includes('/story-plans/')
      ? { plan: { id: 'plan_1', status: 'PENDING' } }
      : { action: 'generation_requeued', job: { id: 'job_1', status: 'RESERVED' } }
  }

  const plan = await client.resumePlan('plan_1', 'probe-plan-key')
  const job = await client.resumeJob('job_1', 'probe-job-key')

  assert.equal(plan.id, 'plan_1')
  assert.equal(job.job.id, 'job_1')
  assert.deepEqual(calls, [
    {
      path: '/story-plans/plan_1/resume',
      options: { method: 'POST', idempotencyKey: 'probe-plan-key' },
    },
    {
      path: '/story-jobs/job_1/resume',
      options: { method: 'POST', idempotencyKey: 'probe-job-key' },
    },
  ])
})

test('voice modification summaries track the newest requested range records', () => {
  const summary = summarizeVoiceModifications([
    { startEntryIndex: 4, endEntryIndex: 6, status: 'ready', updatedAt: '2026-07-15T00:00:00Z' },
    { startEntryIndex: 4, endEntryIndex: 6, status: 'failed', updatedAt: '2026-07-15T00:01:00Z' },
    { startEntryIndex: 12, endEntryIndex: 12, status: 'READY', updatedAt: '2026-07-15T00:02:00Z' },
  ], [
    { start: 4, end: 6 },
    { start: 12, end: 12 },
    { start: 20, end: 21 },
  ])
  assert.equal(summary.ready, 1)
  assert.equal(summary.failed, 1)
  assert.equal(summary.pending, 1)
  assert.deepEqual(summary.failedRanges, [{ start: 4, end: 6 }])
  assert.deepEqual(summary.statuses, [
    { start: 4, end: 6, status: 'failed' },
    { start: 12, end: 12, status: 'ready' },
    { start: 20, end: 21, status: 'missing' },
  ])
})

test('failed voice mod retries use stable per-range idempotency keys', async () => {
  const client = new SleeperHit({ baseUrl: 'https://example.test', apiKey: 'test' })
  const calls = []
  client.applyAutotune = async (...args) => calls.push(args)
  const count = await client.retryFailedVoiceMods('artifact_1', {
    ranges: [{ start: 4, end: 6 }, { start: 12, end: 12 }],
    idempotencyKeyPrefix: 'episode-autotune-retry1',
  })
  assert.equal(count, 2)
  assert.equal(calls[0][4].idempotencyKey, 'episode-autotune-retry1-4-6')
  assert.equal(calls[1][4].idempotencyKey, 'episode-autotune-retry1-12-12')
})

test('repair publication finds the published artifact release and refreshes its media', async () => {
  const client = new SleeperHit({ baseUrl: 'https://example.test', apiKey: 'test' })
  const calls = []
  client.request = async (path, options = {}) => {
    calls.push({ path, options })
    if (path.includes('cursor=next')) {
      return {
        releases: [{ id: 'release_2', sourceArtifactId: 'artifact_1', status: 'published' }],
        nextCursor: null,
      }
    }
    if (path.includes('/publishing-series/')) {
      return {
        releases: [{ id: 'release_1', sourceArtifactId: 'other', status: 'published' }],
        nextCursor: 'next',
      }
    }
    return { release: { id: 'release_2' } }
  }

  const releaseId = await client.refreshPublishedEpisodeMedia('series_1', 'artifact_1', {
    idempotencyKey: 'episode-refresh-media-repair_1',
  })
  assert.equal(releaseId, 'release_2')
  assert.equal(calls.length, 3)
  assert.equal(calls[2].path, '/publishing-releases/release_2/refresh-media')
  assert.equal(calls[2].options.idempotencyKey, 'episode-refresh-media-repair_1')
  assert.deepEqual(calls[2].options.body, { sourceArtifactId: 'artifact_1' })
})

test('repair publication returns null without creating a duplicate when no release matches', async () => {
  const client = new SleeperHit({ baseUrl: 'https://example.test', apiKey: 'test' })
  const calls = []
  client.request = async (path, options = {}) => {
    calls.push({ path, options })
    return { releases: [], nextCursor: null }
  }
  assert.equal(await client.refreshPublishedEpisodeMedia('series_1', 'artifact_1'), null)
  assert.equal(calls.length, 1)
  assert.match(calls[0].path, /status=published/)
})

test('normal publish uses deterministic keys across release, description, and publish calls', async () => {
  const client = new SleeperHit({ baseUrl: 'https://example.test', apiKey: 'test' })
  const calls = []
  client.request = async (path, options = {}) => {
    calls.push({ path, options })
    return path.includes('/publishing-series/') ? { release: { id: 'release_1' } } : {}
  }
  await client.publishEpisode('series_1', {
    title: 'Episode',
    descriptionDirection: 'Describe it',
    artifactId: 'artifact_1',
    idempotencyKeyPrefix: 'episode-publish',
  })
  assert.deepEqual(calls.map((call) => call.options.idempotencyKey), [
    'episode-publish-release',
    'episode-publish-description',
    'episode-publish-publish',
  ])
})

test('SFX add forwards exact duration and returns the generated cue', async () => {
  const client = new SleeperHit({ baseUrl: 'https://example.test', apiKey: 'test' })
  const calls = []
  const expectedCue = {
    id: 'cue_1', entryIndex: 17, generatedDurationS: 0.5,
    soundUrl: 'https://cdn.test/click.mp3', isDraft: false,
  }
  client.request = async (path, options) => {
    calls.push({ path, options })
    return { cue: expectedCue }
  }

  const cue = await client.addSfxCue('artifact_1', {
    entryIndex: 17,
    label: 'Dial Click',
    prompt: 'One clear click.',
    volume: 0.42,
    generatedDurationS: 0.5,
    enabled: true,
    idempotencyKey: 'episode-click-17-add',
  })

  assert.equal(cue, expectedCue)
  assert.deepEqual(calls, [{
    path: '/artifacts/artifact_1/sfx',
    options: {
      method: 'POST',
      idempotencyKey: 'episode-click-17-add',
      body: {
        op: 'add',
        entryIndex: 17,
        label: 'Dial Click',
        prompt: 'One clear click.',
        volume: 0.42,
        generatedDurationS: 0.5,
        enabled: true,
      },
    },
  }])
})

test('SFX repair updates and regenerates the existing cue with its repair key', async () => {
  const client = new SleeperHit({ baseUrl: 'https://example.test', apiKey: 'test' })
  const calls = []
  const expectedCue = {
    id: 'cue_old', entryIndex: 17, generatedDurationS: 0.5,
    soundUrl: 'https://cdn.test/repaired-click.mp3', isDraft: false,
  }
  client.request = async (path, options) => {
    calls.push({ path, options })
    return { cue: expectedCue }
  }

  const cue = await client.updateSfxCue('artifact_1', 'cue_old', {
    entryIndex: 17,
    label: 'Dial Click',
    prompt: 'One clear click.',
    volume: 0.42,
    generatedDurationS: 0.5,
    enabled: true,
    regenerate: true,
  }, { idempotencyKey: 'episode-repair-click-17-update' })

  assert.equal(cue, expectedCue)
  assert.deepEqual(calls, [{
    path: '/artifacts/artifact_1/sfx',
    options: {
      method: 'POST',
      idempotencyKey: 'episode-repair-click-17-update',
      body: {
        op: 'update',
        id: 'cue_old',
        entryIndex: 17,
        label: 'Dial Click',
        prompt: 'One clear click.',
        volume: 0.42,
        generatedDurationS: 0.5,
        enabled: true,
        regenerate: true,
      },
    },
  }])
})
