import test from 'node:test'
import assert from 'node:assert/strict'

import { constantTimeTokenEqual, operatorAuthorization } from '../worker/operator-auth.mjs'

test('operator recovery endpoints stay disabled until a token is configured', async () => {
  const request = new Request('https://hnradio.test/api/dramas/id/repair', {
    method: 'POST',
    headers: { Authorization: 'Bearer anything' },
  })
  assert.equal(await operatorAuthorization(request, ''), 'disabled')
  assert.equal(await operatorAuthorization(request, undefined), 'disabled')
})

test('operator recovery authorization requires the exact Bearer credential', async () => {
  const authorized = new Request('https://hnradio.test/api/dramas/id/repair', {
    headers: { Authorization: 'Bearer correct-token' },
  })
  const denied = new Request('https://hnradio.test/api/dramas/id/repair', {
    headers: { Authorization: 'Bearer wrong-token' },
  })
  assert.equal(await operatorAuthorization(authorized, 'correct-token'), 'authorized')
  assert.equal(await operatorAuthorization(denied, 'correct-token'), 'denied')
  assert.equal(await constantTimeTokenEqual('same', 'same'), true)
  assert.equal(await constantTimeTokenEqual('same', 'different'), false)
})
