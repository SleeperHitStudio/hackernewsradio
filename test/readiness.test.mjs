import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MIN_EPISODE_CREDITS,
  evaluateReadiness,
  publishKeyPrefix,
  publishingReadiness,
  readReadiness,
  standingApprovalOf,
} from '../worker/readiness.mjs'
import { needsPublishOnly, planApprovalBody, PUBLISHED_PROGRESS_MESSAGE } from '../worker/publishing.mjs'

const READY_GATE = { ready: true, stage: 'ready', reason: null, missingFields: [], canPlan: true, canStartEpisode: true }

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
  })
  assert.equal(result.ready, false)
  assert.equal(result.failureClass, 'project_not_ready')
  assert.equal(result.code, 'project_precondition_failed')
  assert.equal(result.details.stage, 'full_coverage')
  assert.match(result.message, /stage full_coverage/)
})

test('a table read the platform cannot voice is not ready', () => {
  const result = evaluateReadiness({
    project: { workspaceGate: READY_GATE, tableReadReadiness: { ready: false, reason: 'GRUNER has no voice in the cast canon.', missingVoices: ['GRUNER'] } },
    credits: { balance: 500 },
  })
  assert.equal(result.failureClass, 'cast_not_ready')
  assert.deepEqual(result.details.missing, ['GRUNER'])
})

test('a balance that cannot cover one episode is a quota block', () => {
  const short = evaluateReadiness({ project: { workspaceGate: READY_GATE }, credits: { balance: 25 } })
  assert.equal(short.failureClass, 'quota')
  assert.deepEqual(short.details, { balance: 25, required: 26 })
  assert.equal(evaluateReadiness({ project: { workspaceGate: READY_GATE }, credits: { balance: 26 } }).ready, true)
})

test('fields the platform does not report yet are not treated as refusals', () => {
  // Before the platform ships workspaceGate / tableReadReadiness the project
  // read has neither; the preflight must not stop the show on their absence.
  assert.equal(evaluateReadiness({ project: { id: 'p' }, credits: { balance: 100 } }).ready, true)
  assert.equal(evaluateReadiness({ project: { id: 'p' }, credits: null }).ready, true)
})

test('the standing approval is unknown until the platform reports the field', () => {
  assert.deepEqual(standingApprovalOf({ id: 's' }), {
    known: false, granted: false, keyId: null, grantedAt: null, boundElsewhere: false,
  })
  const granted = standingApprovalOf({ standingApproval: { keyId: 'key_hnr', grantedAt: '2026-09-29T00:00:00.000Z' } })
  assert.equal(granted.known, true)
  assert.equal(granted.granted, true)
  const flat = standingApprovalOf({ standingApprovalKeyId: 'key_hnr', standingApprovalGrantedAt: '2026-09-29T00:00:00.000Z' })
  assert.equal(flat.granted, true)
  assert.equal(flat.grantedAt, '2026-09-29T00:00:00.000Z')
  assert.equal(standingApprovalOf({ standingApproval: null }).granted, false, 'a reported null is a known absence')
  assert.equal(standingApprovalOf({ standingApproval: { keyId: 'key_hnr', revokedAt: '2026-09-30T00:00:00Z' } }).granted, false)
})

test('a grant bound to another key does not cover HNR when HNR knows its own key id', () => {
  const approval = standingApprovalOf({ standingApproval: { keyId: 'key_other' } }, { keyId: 'key_hnr' })
  assert.equal(approval.granted, false)
  assert.equal(approval.boundElsewhere, true)
  assert.equal(publishingReadiness({ seriesId: 's', series: { standingApproval: { keyId: 'key_other' } }, keyId: 'key_hnr' }).code,
    'standing_approval_other_key')
})

test('publishing is blocked, with a reason, in every state but a granted series', () => {
  assert.equal(publishingReadiness({ seriesId: null }).state, 'none')
  assert.equal(publishingReadiness({ seriesId: 's', readError: { code: 'insufficient_scope', message: 'Missing publishing:read' } }).code, 'insufficient_scope')
  assert.equal(publishingReadiness({ seriesId: 's', series: { id: 's' } }).code, 'standing_approval_unavailable')
  assert.equal(publishingReadiness({ seriesId: 's', series: { standingApproval: null } }).code, 'standing_approval_missing')
  const granted = publishingReadiness({ seriesId: 's', series: { standingApproval: { keyId: 'k' } } })
  assert.equal(granted.state, 'granted')
  assert.equal(granted.reason, null)
})

test('release keys are scoped to the grant, so a re-grant never replays a pre-grant release', () => {
  const first = publishKeyPrefix('drama_1', { grantedAt: '2026-09-29T00:00:00.000Z' })
  const regrant = publishKeyPrefix('drama_1', { grantedAt: '2026-10-05T00:00:00.000Z' })
  assert.match(first, /^drama_1-publish-g[0-9a-z]+$/)
  assert.notEqual(first, regrant)
  assert.equal(publishKeyPrefix('drama_1', { grantedAt: null }), 'drama_1-publish-g0')
})

test('the preflight reads never throw; a failed read is reported, not guessed', async () => {
  const failing = {
    async getProject() { throw Object.assign(new Error('Service Unavailable'), { status: 503 }) },
  }
  const unread = await readReadiness(failing, { projectId: 'p' })
  assert.equal(unread.checked, false)
  assert.equal(unread.stage, 'project')
  assert.equal(unread.error.status, 503)

  const calls = []
  const sh = {
    async getProject(id) { calls.push(['project', id]); return { workspaceGate: READY_GATE } },
    async getCredits() { calls.push(['credits']); return { balance: 90 } },
    async getPublishingSeries(id) { calls.push(['series', id]); throw Object.assign(new Error('Missing scope'), { status: 403, code: 'insufficient_scope' }) },
  }
  const read = await readReadiness(sh, { projectId: 'p', seriesId: 's' })
  assert.deepEqual(calls, [['project', 'p'], ['credits'], ['series', 's']])
  assert.equal(read.checked, true)
  assert.equal(read.ready, true)
  assert.equal(read.balance, 90)
  assert.equal(read.publishing.state, 'blocked')
  assert.equal(read.publishing.code, 'insufficient_scope')
})

test('plan approval claims a human confirmation only when no grant is reported', () => {
  assert.deepEqual(planApprovalBody({ granted: true }), {})
  assert.deepEqual(planApprovalBody({ granted: false }), { userConfirmed: true })
  assert.deepEqual(planApprovalBody(null), { userConfirmed: true })
})

test('only a finished, unpublished MP3 needs the publish step alone', () => {
  const finished = { status: 'ready', audioUrl: 'a.mp3', artifactId: 'art', progress: [] }
  assert.equal(needsPublishOnly(finished), true)
  assert.equal(needsPublishOnly({ ...finished, progress: [{ message: PUBLISHED_PROGRESS_MESSAGE }] }), false)
  assert.equal(needsPublishOnly({ ...finished, audioUrl: null }), false, 'no MP3 yet: post-production is still owed')
  assert.equal(needsPublishOnly({ ...finished, status: 'failed' }), false)
})
