import test from 'node:test'
import assert from 'node:assert/strict'

import { alertOnce } from '../worker/alerts.mjs'
import { claimSetting } from '../worker/store.mjs'

const env = (db) => ({ DB: db, RESEND_API_KEY: 'resend_test', ALERT_EMAIL: 'ops@example.com' })

/** A settings table with SQLite's conditional-upsert semantics. */
function settingsDb() {
  const store = new Map()
  return {
    store,
    prepare(sql) {
      const q = sql.replace(/\s+/g, ' ').trim()
      return {
        bind(key, value) {
          return {
            async run() {
              const claim = q.includes('WHERE settings.value IS NULL')
              const current = store.get(key)
              if (claim && current !== undefined && current !== 'null') return { meta: { changes: 0 } }
              store.set(key, value)
              return { meta: { changes: 1 } }
            },
          }
        },
      }
    },
  }
}

function mockResend(t, { ok = true } = {}) {
  const sent = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (_url, options) => {
    // Yield, so two concurrent alerts genuinely interleave around the send.
    await new Promise((resolve) => setTimeout(resolve, 1))
    sent.push(JSON.parse(options.body))
    return { ok }
  }
  t.after(() => { globalThis.fetch = realFetch })
  return sent
}

const setSettingOn = (db) => async (_db, key, value) => { db.store.set(key, JSON.stringify(value)) }

test('two concurrent publish runs send the blocked-feed email once', async (t) => {
  const db = settingsDb()
  const sent = mockResend(t)
  const deps = { claimSetting, setSetting: setSettingOn(db) }
  const results = await Promise.all([
    alertOnce(env(db), 'alertLatch:x', { subject: 'blocked', lines: ['a'] }, deps),
    alertOnce(env(db), 'alertLatch:x', { subject: 'blocked', lines: ['b'] }, deps),
  ])
  assert.deepEqual(results.sort(), [false, true])
  assert.equal(sent.length, 1)
})

test('a send Resend refuses releases the latch, so the next observation retries', async (t) => {
  const db = settingsDb()
  mockResend(t, { ok: false })
  const deps = { claimSetting, setSetting: setSettingOn(db) }
  assert.equal(await alertOnce(env(db), 'alertLatch:x', { subject: 's', lines: [] }, deps), false)
  assert.equal(db.store.get('alertLatch:x'), 'null')
  assert.equal(await claimSetting(db, 'alertLatch:x', { again: true }), true, 'a released latch can be claimed')
})
