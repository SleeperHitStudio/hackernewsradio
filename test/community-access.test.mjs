import test from 'node:test'
import assert from 'node:assert/strict'

import { communityConfig } from '../worker/community-access.mjs'

test('Turnstile config is exposed only when a complete key pair exists', () => {
  assert.deepEqual(communityConfig({}), { turnstileSiteKey: null })
  assert.deepEqual(communityConfig({ TURNSTILE_SITE_KEY: 'site' }), { turnstileSiteKey: null })
  assert.deepEqual(communityConfig({
    TURNSTILE_SITE_KEY: 'site',
    TURNSTILE_SECRET_KEY: 'secret',
  }), { turnstileSiteKey: 'site' })
})

test('legacy Turnstile client key names remain compatible', () => {
  assert.deepEqual(communityConfig({
    TURNSTILE_CLIENT_ID: 'legacy-site',
    TURNSTILE_CLIENT_SECRET: 'legacy-secret',
  }), { turnstileSiteKey: 'legacy-site' })
})
