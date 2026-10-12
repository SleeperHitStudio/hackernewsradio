import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { register } from 'node:module'

// Import the real HTTP handler without starting a Cloudflare Workflow.
const workersStub = 'data:text/javascript,' + encodeURIComponent('export class WorkflowEntrypoint {}')
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') return { url: ${JSON.stringify(workersStub)}, shortCircuit: true }
  return next(specifier, context)
}`))
const { default: worker } = await import('../worker/index.mjs')

const NEW_MEDIA_ORIGIN = 'https://files.sleeperhit.studio'
const OLD_MEDIA_ORIGIN = 'https://files.sleeperhitlist.com'
const SHELL = '<html><head><title>HNR</title></head><body></body></html>'

function directives(policy) {
  assert.ok(policy, 'the response must have a Content-Security-Policy')
  const result = new Map()
  for (const directive of policy.split(';').map((part) => part.trim()).filter(Boolean)) {
    const [name, ...sources] = directive.split(/\s+/)
    assert.equal(result.has(name), false, `duplicate CSP directive: ${name}`)
    result.set(name, sources)
  }
  return result
}

function assetEnv() {
  return { ASSETS: { async fetch() { return new Response(SHELL, { headers: { 'Content-Type': 'text/html' } }) } } }
}

test('Worker API and SPA responses allow both exact episode media origins', async () => {
  for (const path of ['/api/health', '/']) {
    const response = await worker.fetch(new Request(`https://hnradio.test${path}`), assetEnv())
    assert.equal(response.status, 200)
    const policy = directives(response.headers.get('Content-Security-Policy'))
    assert.deepEqual(policy.get('media-src'), ["'self'", NEW_MEDIA_ORIGIN, OLD_MEDIA_ORIGIN], path)
    assert.deepEqual(policy.get('default-src'), ["'self'"])
    assert.deepEqual(policy.get('img-src'), ["'self'", 'data:'])
    assert.deepEqual(policy.get('frame-ancestors'), ["'none'"])
  }
})

test('ASSETS header policy matches the Worker and allows both exact media origins', async () => {
  const headers = await readFile(new URL('../web/public/_headers', import.meta.url), 'utf8')
  const policy = headers.match(/^\s*Content-Security-Policy:\s*(.+)$/m)?.[1]
  assert.deepEqual(directives(policy).get('media-src'), ["'self'", NEW_MEDIA_ORIGIN, OLD_MEDIA_ORIGIN])
  const response = await worker.fetch(new Request('https://hnradio.test/api/health'), assetEnv())
  assert.deepEqual(directives(policy), directives(response.headers.get('Content-Security-Policy')))
})

test('episode OG audio keeps the stored URL on either media host under the dual-host policy', async () => {
  for (const origin of [NEW_MEDIA_ORIGIN, OLD_MEDIA_ORIGIN]) {
    const audioUrl = `${origin}/table-read/finalized/episode/full-mix.mp3`
    const drama = { hnId: '42', title: 'Episode', commentCount: 12, status: 'ready', audioUrl }
    const env = {
      ...assetEnv(),
      DB: {
        prepare(sql) {
          assert.match(sql, /^SELECT data FROM episodes WHERE hn_id/)
          return { bind(id, mode) {
            assert.equal(id, '42')
            assert.equal(mode, 'podcast')
            return { async first() { return { data: JSON.stringify(drama) } } }
          } }
        },
      },
    }
    const response = await worker.fetch(new Request('https://hnradio.test/e/42'), env)
    assert.equal(response.status, 200)
    assert.ok(directives(response.headers.get('Content-Security-Policy')).get('media-src').includes(origin))
    assert.ok((await response.text()).includes(`<meta property="og:audio" content="${audioUrl}" />`))
  }
})

test('player, RSS and other runtime sources have no additional old-media-host pin', async () => {
  const root = new URL('../', import.meta.url)
  const allowed = new Set(['worker/index.mjs', 'web/public/_headers'])
  const violations = []
  async function walk(relative) {
    for (const entry of await readdir(new URL(relative, root), { withFileTypes: true })) {
      const path = `${relative}${entry.name}`
      if (entry.isDirectory() && entry.name !== 'node_modules') await walk(`${path}/`)
      else if (entry.isFile() && (/\.(mjs|jsx|html|css)$/.test(path) || path.endsWith('/_headers'))) {
        const source = await readFile(new URL(path, root), 'utf8')
        if (source.includes('files.sleeperhitlist.com') && !allowed.has(path)) violations.push(path)
      }
    }
  }
  for (const dir of ['worker/', 'server/', 'web/']) await walk(dir)
  assert.deepEqual(violations, [])
  const player = await readFile(new URL('../web/src/App.jsx', import.meta.url), 'utf8')
  assert.match(player, /src=\{drama\.audioUrl\}/)
  const shell = await readFile(new URL('../web/index.html', import.meta.url), 'utf8')
  assert.match(shell, /type="application\/rss\+xml"[^>]+href="https:\/\/sleeperhit\.studio\/api\/v1\/publishing-feeds\/hnr\.xml"/)
})
