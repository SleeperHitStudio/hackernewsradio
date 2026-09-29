import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MIN_EPISODE_CREDITS,
  approvalFailure,
  evaluateReadiness,
  isRefusedRead,
  publishKeyPrefix,
  publishingReadiness,
  readReadiness,
} from '../worker/readiness.mjs'
import { PLAN_APPROVAL_BODY, needsPublishOnly, PUBLISHED_PROGRESS_MESSAGE } from '../worker/publishing.mjs'

const READY_GATE = { ready: true, stage: 'ready', reason: null, missingFields: [], canPlan: true, canStartEpisode: true }
const KEY = 'key_hnr'
const GRANT = { apiKeyId: KEY, apiKeyName: 'HNR', apiKeyStart: 'sh_hn', grantedAt: '2026-09-29T00:00:00.000Z', grantedBy: 'user_1' }
const SERIES = { id: 's', status: 'active', medium: 'audio', standingApproval: GRANT }
const GRANTED = publishingReadiness({ seriesId: 's', series: SERIES, keyId: KEY })

test('one episode costs a table read plus its finalize', () => {
  assert.equal(MIN_EPISODE_CREDITS, 26)
})

test('a project whose workspace gate is not passed is not ready, and says which stage', () => {
  const result = evaluateReadiness({
    project: {
      workspaceGate: {
        ready: false,
        stage: 'full_coverage',
        reason: 'Pass full Series Bible coverage before starting episodes, project videos, or publishing.',
        missingFields: [],
        canPlan: true,
        canStartEpisode: false,
      },
    },
    credits: { balance: 500 },
    publishing: GRANTED,
  })
  assert.equal(result.ready, false)
  assert.equal(result.failureClass, 'project_not_ready')
  assert.equal(result.code, 'project_precondition_failed')
  assert.equal(result.details.stage, 'full_coverage')
  assert.match(result.message, /stage full_coverage/)
})

test('a table read the canon cannot cover is not ready, and names who is missing what (PR 3 shape)', () => {
  const result = evaluateReadiness({
    project: {
      workspaceGate: READY_GATE,
      tableReadReadiness: {
        ready: false,
        audioOnly: true,
        reason: 'GRUNER has no voice in the cast canon.',
        narratorVoice: false,
        members: [
          { name: 'GARY', narrator: false, ready: true, missing: [] },
          { name: 'GRUNER', narrator: false, ready: false, missing: ['voice'] },
        ],
      },
    },
    credits: { balance: 500 },
    publishing: GRANTED,
  })
  assert.equal(result.failureClass, 'cast_not_ready')
  assert.deepEqual(result.details.missing, ['GRUNER (voice)'])
})

test('a balance that cannot cover one episode is a quota block', () => {
  const short = evaluateReadiness({ project: { workspaceGate: READY_GATE }, credits: { balance: 25 }, publishing: GRANTED })
  assert.equal(short.failureClass, 'quota')
  assert.deepEqual(short.details, { balance: 25, required: 26 })
  assert.equal(evaluateReadiness({ project: { workspaceGate: READY_GATE }, credits: { balance: 26 }, publishing: GRANTED }).ready, true)
  assert.equal(evaluateReadiness({ project: { workspaceGate: READY_GATE }, credits: { balance: 28 }, publishing: GRANTED, minCredits: 30 }).failureClass,
    'quota', 'a refused job that costs more raises the floor')
})

test('no standing approval is not ready: HNR spends nothing it cannot approve', () => {
  const result = evaluateReadiness({
    project: { workspaceGate: READY_GATE },
    credits: { balance: 500 },
    publishing: publishingReadiness({ seriesId: 's', series: { ...SERIES, standingApproval: null }, keyId: KEY }),
  })
  assert.equal(result.ready, false)
  assert.equal(result.failureClass, 'approval_missing')
  assert.equal(result.code, 'standing_approval_missing')
  assert.equal(approvalFailure(GRANTED), null)
  assert.equal(approvalFailure(null), null, 'an absent publishing read is not a measurement')
})

test('a read reports what it measured, so a pass clears only what it could see', () => {
  assert.deepEqual(
    evaluateReadiness({ project: { id: 'p' }, credits: { balance: 100 } }).measured,
    ['access', 'quota'],
    'before the platform reports the gate, cast readiness or the grant, none of them is measured',
  )
  assert.deepEqual(
    evaluateReadiness({
      project: { workspaceGate: READY_GATE, tableReadReadiness: { ready: true, members: [] } },
      credits: { balance: 100 },
      publishing: GRANTED,
    }).measured,
    ['access', 'project_not_ready', 'cast_not_ready', 'approval_missing', 'quota'],
  )
  assert.equal(evaluateReadiness({ project: { id: 'p' }, credits: null }).ready, true,
    'fields the platform does not report are not refusals')
})

test('the standing approval covers HNR only when bound to HNR\'s own key on an active audio series (PR 6 shape)', () => {
  assert.equal(GRANTED.state, 'granted')
  assert.deepEqual(GRANTED.grant, { keyId: KEY, grantedAt: '2026-09-29T00:00:00.000Z' })
  const code = (series, keyId = KEY) => publishingReadiness({ seriesId: 's', series, keyId }).code
  assert.equal(code({ id: 's' }), 'standing_approval_unavailable', 'a platform that does not report the grant')
  assert.equal(code({ ...SERIES, standingApproval: null }), 'standing_approval_missing', 'never granted, or revoked')
  assert.equal(code({ ...SERIES, standingApproval: { ...GRANT, apiKeyId: 'key_other' } }), 'standing_approval_other_key')
  assert.equal(code({ ...SERIES, standingApproval: { ...GRANT, apiKeyId: null } }), 'standing_approval_other_key',
    'held only by the built-in runner')
  assert.equal(code(SERIES, null), 'standing_approval_unverifiable', 'HNR must know its own key id')
  assert.equal(code({ ...SERIES, status: 'paused' }), 'standing_approval_inactive')
  assert.equal(code({ ...SERIES, medium: 'video' }), 'standing_approval_inactive')
  assert.equal(code({ ...SERIES, standingApproval: { keyId: KEY, grantedAt: GRANT.grantedAt } }), 'standing_approval_other_key',
    'one contract: the grant names its key as apiKeyId')
  assert.equal(code({ id: 's', standingApprovalKeyId: KEY, standingApprovalGrantedAt: GRANT.grantedAt }), 'standing_approval_unavailable',
    'one contract: flat fields are not a grant')
})

test('publishing is blocked, with a reason, in every state but a granted series', () => {
  const none = publishingReadiness({ seriesId: null })
  assert.equal(none.state, 'none')
  assert.equal(none.code, 'publishing_series_missing')
  const unread = publishingReadiness({ seriesId: 's', readError: { status: 403, code: 'insufficient_scope', message: 'Missing publishing:read' }, keyId: KEY })
  assert.equal(unread.state, 'blocked')
  assert.equal(unread.code, 'standing_approval_unreadable')
  assert.match(unread.reason, /403 insufficient_scope/)
  assert.equal(GRANTED.reason, null)
})

test('release keys are scoped to the grant, so a re-grant never replays a pre-grant release', () => {
  const first = publishKeyPrefix('drama_1', { grantedAt: '2026-09-29T00:00:00.000Z' })
  const regrant = publishKeyPrefix('drama_1', { grantedAt: '2026-10-05T00:00:00.000Z' })
  assert.match(first, /^drama_1-publish-g[0-9a-z]+$/)
  assert.notEqual(first, regrant)
  assert.equal(publishKeyPrefix('drama_1', { grantedAt: null }), 'drama_1-publish-g0')
})

test('a refused read is a 4xx the API meant; 408/425/429 and 5xx are not', () => {
  assert.equal(isRefusedRead({ status: 401 }), true)
  assert.equal(isRefusedRead({ status: 404 }), true)
  for (const status of [0, 408, 425, 429, 500, 503]) assert.equal(isRefusedRead({ status }), false, String(status))
})

test('a read that could not be made is unchecked; a read the API refused is an access failure', async () => {
  const failing = (status, code) => ({
    async getProject() { throw Object.assign(new Error(status === 503 ? 'Service Unavailable' : 'API key revoked'), { status, code }) },
  })
  const unread = await readReadiness(failing(503), { projectId: 'p' })
  assert.equal(unread.checked, false)
  assert.equal(unread.stage, 'project')
  assert.equal(unread.error.status, 503)

  const revoked = await readReadiness(failing(401, 'api_key_revoked'), { projectId: 'p' })
  assert.equal(revoked.checked, true)
  assert.equal(revoked.ready, false)
  assert.equal(revoked.failureClass, 'access')
  assert.equal(revoked.code, 'api_key_revoked')
  assert.deepEqual(revoked.details, { stage: 'project', status: 401, code: 'api_key_revoked' })

  const credits = await readReadiness({
    async getProject() { return { workspaceGate: READY_GATE } },
    async getCredits() { throw Object.assign(new Error('Missing credits:read'), { status: 403, code: 'insufficient_scope' }) },
  }, { projectId: 'p' })
  assert.equal(credits.failureClass, 'access')
  assert.equal(credits.details.stage, 'credits')
})

test('the preflight reads the project, the balance and the series; a refused series read is an unreadable grant', async () => {
  const calls = []
  const sh = {
    async getProject(id) { calls.push(['project', id]); return { workspaceGate: READY_GATE } },
    async getCredits() { calls.push(['credits']); return { balance: 90 } },
    async getPublishingSeries(id) { calls.push(['series', id]); throw Object.assign(new Error('Missing scope'), { status: 403, code: 'insufficient_scope' }) },
  }
  const read = await readReadiness(sh, { projectId: 'p', seriesId: 's', keyId: KEY })
  assert.deepEqual(calls, [['project', 'p'], ['credits'], ['series', 's']])
  assert.equal(read.checked, true)
  assert.equal(read.ready, false)
  assert.equal(read.failureClass, 'approval_missing')
  assert.equal(read.balance, 90)
  assert.equal(read.publishing.code, 'standing_approval_unreadable')

  const blip = await readReadiness({
    ...sh,
    async getPublishingSeries() { throw Object.assign(new Error('Bad Gateway'), { status: 502 }) },
  }, { projectId: 'p', seriesId: 's', keyId: KEY })
  assert.equal(blip.checked, false, 'a series read that could not be made skips the tick')
  assert.equal(blip.stage, 'series')

  const granted = await readReadiness({
    ...sh,
    async getPublishingSeries() { return SERIES },
  }, { projectId: 'p', seriesId: 's', keyId: KEY })
  assert.equal(granted.ready, true)
  assert.equal(granted.publishing.state, 'granted')
})

test('plan approval never claims a human confirmation', () => {
  assert.deepEqual(PLAN_APPROVAL_BODY, {})
  assert.equal(Object.isFrozen(PLAN_APPROVAL_BODY), true)
})

test('only a finished MP3 the feed has not taken needs the publish step alone', () => {
  const finished = { status: 'ready', audioUrl: 'a.mp3', artifactId: 'art', progress: [] }
  assert.equal(needsPublishOnly(finished), true)
  assert.equal(needsPublishOnly({ ...finished, progress: [{ message: PUBLISHED_PROGRESS_MESSAGE }] }), false)
  assert.equal(needsPublishOnly({ ...finished, publishState: 'published' }), false,
    'the episode row is the record: a lost progress note does not publish twice')
  assert.equal(needsPublishOnly({ ...finished, releaseId: 'release_1' }), false)
  assert.equal(needsPublishOnly({ ...finished, publishState: 'blocked' }), true)
  assert.equal(needsPublishOnly({ ...finished, audioUrl: null }), false, 'no MP3 yet: post-production is still owed')
  assert.equal(needsPublishOnly({ ...finished, status: 'failed' }), false)
})

test('a cast canon push that could not be made is not a verdict: the read is unchecked', async () => {
  const pinned = { GARY: { voiceId: 'v_gary' }, MAEVE: { voiceId: 'v_maeve' }, OBI: { voiceId: 'v_obi' }, GRUNER: { voiceId: 'v_gruner' } }
  const castNotReady = {
    workspaceGate: READY_GATE,
    tableReadReadiness: { ready: false, members: [{ name: 'GRUNER', ready: false, missing: ['voice'] }] },
  }
  const sh = (canonError) => ({
    async getProject() { return castNotReady },
    async getCredits() { return { balance: 90 } },
    async getCastCanon() { throw canonError },
  })
  const readSetting = async (_db, key) => (key === 'pinnedVoices' ? pinned : null)

  const blip = await readReadiness(sh(Object.assign(new Error('Service Unavailable'), { status: 503 })), { projectId: 'p', db: {}, readSetting })
  assert.equal(blip.checked, false, 'a 5xx says nothing about the cast: the tick skips')
  assert.equal(blip.stage, 'cast canon')

  const refused = await readReadiness(sh(Object.assign(new Error('Missing story:write'), { status: 403, code: 'insufficient_scope' })), { projectId: 'p', db: {}, readSetting })
  assert.equal(refused.checked, true)
  assert.equal(refused.failureClass, 'cast_not_ready')
  assert.equal(refused.code, 'cast_canon_sync_refused')
  assert.match(refused.message, /\(403 insufficient_scope\): Missing story:write/)
  assert.deepEqual(refused.details.missing, ['GRUNER (voice)'])

  const withoutDb = await readReadiness(sh(new Error('must not be called')), { projectId: 'p' })
  assert.equal(withoutDb.failureClass, 'cast_not_ready', 'without a D1 there is nothing to push')
  assert.equal(withoutDb.code, 'cast_precondition_failed')
})
