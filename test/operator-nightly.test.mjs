import test from 'node:test'
import assert from 'node:assert/strict'

import { operatorNightlyReconcile } from '../worker/operator-nightly.mjs'

const endpoint = 'https://hnradio.net/api/operator/nightly/reconcile'

test('the nightly operator reconcile hook is hidden until configured and rejects bad credentials', async () => {
  const disabled = await operatorNightlyReconcile(
    new Request(endpoint, { method: 'POST' }),
    {},
  )
  assert.equal(disabled.status, 404)

  const denied = await operatorNightlyReconcile(new Request(endpoint, {
    method: 'POST',
    headers: { Authorization: 'Bearer wrong-token' },
  }), { HNR_OPERATOR_TOKEN: 'correct-token' })
  assert.equal(denied.status, 401)
})

test('an authorized nightly operator reconcile uses the cron path and returns a compact batch summary', async () => {
  const reconciledAt = new Date('2026-07-22T00:10:00.000Z')
  const calls = []
  const result = await operatorNightlyReconcile(new Request(endpoint, {
    method: 'POST',
    headers: { Authorization: 'Bearer correct-token' },
  }), {
    HNR_OPERATOR_TOKEN: 'correct-token',
    DB: {},
  }, {
    now: () => reconciledAt,
    getDeployGate: async () => null,
    runReconciliation: async (env, options) => {
      calls.push({ env, options })
      return [{
        date: '2026-07-21',
        status: 'running',
        published: 1,
        items: [{ status: 'published' }, { status: 'queued' }, { status: 'superseded' }],
      }]
    },
  })

  assert.equal(result.status, 200)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.now, reconciledAt)
  assert.deepEqual(result.body, {
    reconciledAt: reconciledAt.toISOString(),
    batches: [{ date: '2026-07-21', status: 'running', published: 1, active: 2 }],
  })
})

test('an authorized nightly reconcile honors the deploy safety gate', async () => {
  const now = new Date('2026-07-22T00:10:00.000Z')
  let ran = false
  const result = await operatorNightlyReconcile(new Request(endpoint, {
    method: 'POST',
    headers: { Authorization: 'Bearer correct-token' },
  }), {
    HNR_OPERATOR_TOKEN: 'correct-token',
    DB: {},
  }, {
    now: () => now,
    getDeployGate: async () => ({
      state: 'locked',
      expiresAt: new Date(now.getTime() + 30_000).toISOString(),
    }),
    runReconciliation: async () => { ran = true; return [] },
  })

  assert.equal(result.status, 503)
  assert.equal(result.headers['Retry-After'], '30')
  assert.equal(result.body.code, 'workflow_deploying')
  assert.equal(ran, false)
})
