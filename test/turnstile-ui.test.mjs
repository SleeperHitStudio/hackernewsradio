import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import {
  TURNSTILE_RETRY_MESSAGE,
  acceptTurnstileToken,
  resetRejectedTurnstile,
} from '../web/src/turnstile.mjs'

function stateRecorder() {
  const state = {}
  return {
    state,
    actions: {
      setToken: (value) => { state.token = value },
      setWidgetError: (value) => { state.widgetError = value },
      setWidgetLoaded: (value) => { state.widgetLoaded = value },
      setPageError: (value) => { state.pageError = value },
    },
  }
}

test('a successful Turnstile callback clears stale widget and page errors', () => {
  const { state, actions } = stateRecorder()

  acceptTurnstileToken('fresh-token', actions)

  assert.deepEqual(state, {
    token: 'fresh-token',
    widgetError: null,
    widgetLoaded: true,
    pageError: null,
  })
})

test('a server-rejected token resets the visible widget and exposes retry state', () => {
  const { state, actions } = stateRecorder()
  const resets = []
  let remounts = 0

  const result = resetRejectedTurnstile({
    turnstile: { reset: (widgetId) => resets.push(widgetId) },
    widgetId: 'widget-1',
    ...actions,
    remount: () => { remounts += 1 },
  })

  assert.equal(result, 'reset')
  assert.deepEqual(resets, ['widget-1'])
  assert.equal(remounts, 0)
  assert.deepEqual(state, {
    token: '',
    widgetError: TURNSTILE_RETRY_MESSAGE,
    widgetLoaded: false,
  })
})

test('a stale Turnstile widget id falls back to a full remount', () => {
  const { state, actions } = stateRecorder()
  let remounts = 0

  const result = resetRejectedTurnstile({
    turnstile: { reset: () => { throw new Error('stale widget') } },
    widgetId: 'stale-widget',
    ...actions,
    remount: () => { remounts += 1 },
  })

  assert.equal(result, 'remount')
  assert.equal(remounts, 1)
  assert.equal(state.widgetError, TURNSTILE_RETRY_MESSAGE)
})

test('the honor gate keeps its retry control and omits the Spotify trust disclaimer', async () => {
  const source = await readFile(new URL('../web/src/App.jsx', import.meta.url), 'utf8')

  assert.match(source, /Retry anti-bot check/)
  assert.doesNotMatch(source, /cannot verify public follows|confirmation is based on trust/i)
})
