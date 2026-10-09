import test from 'node:test'
import assert from 'node:assert/strict'

import {
  STORY_JOB_POLL_ATTEMPTS,
  STORY_JOB_POLL_INTERVAL_MS,
  SleeperHit,
  summarizeVoiceModifications,
} from '../worker/sleeperhit.mjs'
import { classifySystemicFailure } from '../worker/failure-classification.mjs'

test('Sleeper client StoryJob polling budget is at least 60 minutes', () => {
  assert.ok(STORY_JOB_POLL_ATTEMPTS * STORY_JOB_POLL_INTERVAL_MS >= 60 * 60 * 1000)
})

test('text source uploads carry the item identity top-level and the full-context policy in metadata', async () => {
  const client = new SleeperHit({ baseUrl: 'https://example.test', apiKey: 'test' })
  const calls = []
  client.request = async (path, options) => {
    calls.push({ path, options })
    return { source: { id: 'source_1', status: 'PENDING' } }
  }
  const metadata = {
    sourceContextMode: 'full',
    sourceCompleteness: { comments: { complete: true, expected: 2, fetched: 2 } },
  }

  const captured = await client.addTextSource('project_1', {
    content: 'ARTICLE-END\nCOMMENT-END',
    label: 'HN thread 42',
    metadata,
    producer: 'hackernewsradio',
    externalId: '42',
    idempotencyKey: 'episode-source',
  })

  assert.deepEqual(captured, { id: 'source_1', deduplicated: false, capturedComments: null, sourceCompleteness: null, commenterNames: null, status: 'PENDING' })
  assert.deepEqual(calls, [{
    path: '/story-projects/project_1/sources',
    options: {
      method: 'POST',
      idempotencyKey: 'episode-source',
      body: {
        type: 'text',
        content: 'ARTICLE-END\nCOMMENT-END',
        label: 'HN thread 42',
        producer: 'hackernewsradio',
        externalId: '42',
        metadata,
      },
    },
  }])
  assert.equal('sourceProducer' in calls[0].options.body.metadata, false)
})

test('a text source says when its thread was posted, top-level, and omits it when unknown', async () => {
  const client = new SleeperHit({ baseUrl: 'https://example.test', apiKey: 'test' })
  const bodies = []
  client.request = async (_path, options) => {
    bodies.push(options.body)
    return { source: { id: 'source_1', status: 'READY' } }
  }
  await client.addTextSource('project_1', {
    content: 'x', producer: 'hackernewsradio', externalId: '42', originatedAt: '2026-09-30T23:30:00.000Z',
  })
  await client.addTextSource('project_1', { content: 'x', producer: 'hackernewsradio', externalId: '43' })
  assert.equal(bodies[0].originatedAt, '2026-09-30T23:30:00.000Z')
  assert.equal('originatedAt' in bodies[1], false)
})

test('a repeat submission of the same thread reports the existing source and what it captured', async () => {
  const client = new SleeperHit({ baseUrl: 'https://example.test', apiKey: 'test' })
  client.request = async () => ({
    deduplicated: true,
    source: {
      id: 'source_first',
      status: 'READY',
      metadata: { commenterNames: 'pseudonym', sourceCompleteness: { comments: { complete: true, expected: 57, fetched: 57 } } },
    },
  })
  const captured = await client.addTextSource('project_1', {
    content: 'x', producer: 'hackernewsradio', externalId: '42', idempotencyKey: 'retry-source',
  })
  assert.deepEqual(captured, {
    id: 'source_first',
    deduplicated: true,
    capturedComments: 57,
    sourceCompleteness: { comments: { complete: true, expected: 57, fetched: 57 } },
    commenterNames: 'pseudonym',
    status: 'READY',
  })
})

test('deduplicated is read from the platform\'s { source, deduplicated } envelope only', async () => {
  const client = new SleeperHit({ baseUrl: 'https://example.test', apiKey: 'test' })
  client.request = async () => ({ source: { id: 'source_1', status: 'READY', deduplicated: true } })
  const captured = await client.addTextSource('project_1', { content: 'x', producer: 'hackernewsradio', externalId: '42' })
  assert.equal(captured.deduplicated, false)
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
    if (path.includes('/releases?')) return { releases: [], nextCursor: null }
    return path.includes('/publishing-series/') ? { release: { id: 'release_1' } } : {}
  }
  const result = await client.publishEpisode('series_1', {
    title: 'Episode',
    descriptionDirection: 'Describe it',
    artifactId: 'artifact_1',
    idempotencyKeyPrefix: 'episode-publish',
  })
  assert.deepEqual(result, { releaseId: 'release_1', alreadyPublished: false })
  assert.deepEqual(calls.slice(1).map((call) => call.options.idempotencyKey), [
    'episode-publish-release',
    'episode-publish-description',
    'episode-publish-publish',
  ])
  // The release names no season: the platform files it in its episode's.
  assert.deepEqual(calls[1].options.body, { title: 'Episode', sourceArtifactId: 'artifact_1', type: 'episode' })
})

function releaseListing(releases) {
  return (path) => (path.includes('/releases?') ? { releases, nextCursor: null } : null)
}

test('an artifact already on the feed is never released twice', async () => {
  const client = new SleeperHit({ baseUrl: 'https://example.test', apiKey: 'test' })
  const calls = []
  const list = releaseListing([
    { id: 'release_other', sourceArtifactId: 'artifact_2', status: 'ready', createdAt: '2026-10-01T00:00:00.000Z' },
    { id: 'release_live', sourceArtifactId: 'artifact_1', status: 'published', createdAt: '2026-09-01T00:00:00.000Z' },
  ])
  client.request = async (path, options = {}) => {
    calls.push({ path, method: options.method || 'GET' })
    return list(path) ?? {}
  }
  const result = await client.publishEpisode('series_1', {
    title: 'Episode', artifactId: 'artifact_1', idempotencyKeyPrefix: 'p', grantedAt: '2026-09-29T00:00:00.000Z',
  })
  assert.deepEqual(result, { releaseId: 'release_live', alreadyPublished: true })
  assert.deepEqual(calls.map((call) => call.method), ['GET'], 'no create, no publish')
})

test('a release the grant covers is reused; one made before the grant is canceled, not left stuck', async () => {
  const client = new SleeperHit({ baseUrl: 'https://example.test', apiKey: 'test' })
  const calls = []
  const list = releaseListing([
    { id: 'release_after', sourceArtifactId: 'artifact_1', status: 'ready', createdAt: '2026-10-02T00:00:00.000Z' },
    { id: 'release_before', sourceArtifactId: 'artifact_1', status: 'ready', createdAt: '2026-09-20T00:00:00.000Z' },
    { id: 'release_gone', sourceArtifactId: 'artifact_1', status: 'canceled', createdAt: '2026-09-10T00:00:00.000Z' },
  ])
  client.request = async (path, options = {}) => {
    calls.push({ path, method: options.method || 'GET', key: options.idempotencyKey })
    return list(path) ?? {}
  }
  const result = await client.publishEpisode('series_1', {
    title: 'Episode', artifactId: 'artifact_1', idempotencyKeyPrefix: 'p', grantedAt: '2026-10-01T00:00:00.000Z',
  })
  assert.deepEqual(result, { releaseId: 'release_after', alreadyPublished: false })
  assert.deepEqual(calls.slice(1).map((call) => `${call.method} ${call.path}`), [
    'POST /publishing-releases/release_before/cancel',
    'POST /publishing-releases/release_after/description/generate',
    'POST /publishing-releases/release_after/publish',
  ], 'no second release is created')
  assert.equal(calls[1].key, 'p-cancel-release_before')
})

test('a re-grant cancels the pre-grant release and creates exactly one new one', async () => {
  const client = new SleeperHit({ baseUrl: 'https://example.test', apiKey: 'test' })
  const calls = []
  const list = releaseListing([
    { id: 'release_before', sourceArtifactId: 'artifact_1', status: 'failed', createdAt: '2026-09-20T00:00:00.000Z' },
  ])
  client.request = async (path, options = {}) => {
    calls.push({ path, method: options.method || 'GET' })
    if (path === '/publishing-series/series_1/releases') return { release: { id: 'release_new' } }
    return list(path) ?? {}
  }
  const result = await client.publishEpisode('series_1', {
    title: 'Episode', artifactId: 'artifact_1', idempotencyKeyPrefix: 'p', grantedAt: '2026-10-01T00:00:00.000Z',
  })
  assert.equal(result.releaseId, 'release_new')
  assert.deepEqual(calls.slice(1).map((call) => `${call.method} ${call.path}`), [
    'POST /publishing-releases/release_before/cancel',
    'POST /publishing-series/series_1/releases',
    'POST /publishing-releases/release_new/description/generate',
    'POST /publishing-releases/release_new/publish',
  ])
})

test('plan approval is never a client call that claims a human confirmation', () => {
  const client = new SleeperHit({ baseUrl: 'https://example.test', apiKey: 'test' })
  assert.equal(typeof client.approvePlan, 'undefined')
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

test('a failed voice mod carries the reason the platform recorded', () => {
  // The Story API records WHY a render failed on the record's `error` and
  // returns it on the artifact manifest. HNR used to read only `status`, so a
  // Hume credit cliff reached the episode as a bare render timeout — fifteen
  // times in a row, with the real cause sitting unread in the payload.
  const summary = summarizeVoiceModifications([
    {
      startEntryIndex: 4,
      endEntryIndex: 6,
      status: 'failed',
      updatedAt: '2026-08-11T02:00:00Z',
      error: 'Hume TTS error (400): {"slug":"zero_credits","message":"Exhausted credit balance."}',
    },
    { startEntryIndex: 12, endEntryIndex: 12, status: 'ready', updatedAt: '2026-08-11T02:01:00Z' },
  ], [{ start: 4, end: 6 }, { start: 12, end: 12 }])

  assert.equal(summary.failed, 1)
  assert.match(summary.lastError, /Exhausted credit balance/)
  assert.deepEqual(summary.failureReasons.length, 1)
})

test('a failure the platform left blank does not invent a reason', () => {
  const summary = summarizeVoiceModifications(
    [{ startEntryIndex: 4, endEntryIndex: 6, status: 'failed', updatedAt: '2026-08-11T02:00:00Z' }],
    [{ start: 4, end: 6 }],
  )
  assert.equal(summary.failed, 1)
  assert.equal(summary.lastError, null)
  assert.deepEqual(summary.failureReasons, [])
})

test('a surfaced provider credit-balance reason classifies as a provider quota cliff', () => {
  // This is the payoff: naming the reason is what lets the nightly reconciler
  // CLASSIFY it. A provider quota failure opens the generation circuit and
  // emails the operator, instead of spending attempts on a provider that is out
  // of money. It is Hume's balance, not Studio Credits, so the free credit read
  // cannot see it: the class is provider_quota, probed by one episode. An
  // unnamed timeout classifies as nothing at all.
  const summary = summarizeVoiceModifications([
    {
      startEntryIndex: 4,
      endEntryIndex: 6,
      status: 'failed',
      updatedAt: '2026-08-11T02:00:00Z',
      error: 'Hume TTS error (400): Exhausted credit balance. Visit platform.hume.ai/billing',
    },
  ], [{ start: 4, end: 6 }])

  const surfaced = `autotune render a2 timed out. Last render failure: ${summary.lastError}`
  assert.equal(classifySystemicFailure(surfaced), 'provider_quota')
  assert.equal(classifySystemicFailure('autotune render a2 timed out.'), null,
    'the bare timeout HNR used to report classifies as nothing')
})

test('the legacy local server approves plans without a fabricated confirmation too', async () => {
  const { SleeperHit: LegacySleeperHit } = await import('../server/sleeperhit.mjs')
  const client = new LegacySleeperHit({ baseUrl: 'https://example.test', apiKey: 'test' })
  const calls = []
  client.request = async (path, options = {}) => { calls.push({ path, options }) }
  await client.approvePlan('plan_1')
  assert.equal(calls[0].path, '/story-plans/plan_1/approve')
  assert.deepEqual(calls[0].options.body, {}, 'no userConfirmed: nobody was asked')
})
