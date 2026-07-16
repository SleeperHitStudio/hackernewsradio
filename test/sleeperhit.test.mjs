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
