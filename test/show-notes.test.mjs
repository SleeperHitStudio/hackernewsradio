import assert from 'node:assert/strict'
import test from 'node:test'

import { EPISODE_DESCRIPTION_DIRECTION, composeShowNotes, showNotesLinks } from '../worker/publishing.mjs'
import { SleeperHit } from '../worker/sleeperhit.mjs'

const THREAD = 'https://news.ycombinator.com/item?id=42'

test('show notes: the sentence, then a link to the thread and the article, and a line on invented names', () => {
  assert.equal(
    composeShowNotes('  A thread   fights about tabs.  ', { threadUrl: THREAD, articleUrl: 'https://publisher.example/story?x=1' }),
    [
      'A thread fights about tabs.',
      '',
      `The Hacker News thread: ${THREAD}`,
      'The article: https://publisher.example/story?x=1',
      'Commenters are heard under invented names.',
    ].join('\n'),
  )
  assert.equal(
    composeShowNotes('', { threadUrl: THREAD }),
    [`The Hacker News thread: ${THREAD}`, 'Commenters are heard under invented names.'].join('\n'),
    'a self-post thread has no article',
  )
  assert.doesNotMatch(composeShowNotes('x', { threadUrl: THREAD, articleUrl: 'javascript:alert(1)' }), /javascript/, 'only a web link')
  assert.throws(() => composeShowNotes('x', {}), /Hacker News thread link/)
  assert.throws(() => composeShowNotes('x', { threadUrl: 'https://evil.example/item?id=42' }), /Hacker News thread link/)
})

test('the notes add no name of their own: only links and the line on invented names', () => {
  const notes = composeShowNotes('', { threadUrl: THREAD, articleUrl: 'https://publisher.example/story' })
  // Nothing in what HNR appends names a person: the thread link is an item id, never a user page.
  assert.doesNotMatch(notes, /user\?id=|@\w/)
  assert.match(EPISODE_DESCRIPTION_DIRECTION, /never write a username or handle/)
})

test('the links come from the episode row: its thread, then its article (or the source proof\'s)', () => {
  assert.deepEqual(showNotesLinks({ url: THREAD, articleUrl: 'https://a.example/x' }), { threadUrl: THREAD, articleUrl: 'https://a.example/x' })
  assert.deepEqual(
    showNotesLinks({ hnId: '7', sourceCompleteness: { article: { url: 'https://b.example/y' } } }),
    { threadUrl: 'https://news.ycombinator.com/item?id=7', articleUrl: 'https://b.example/y' },
  )
  assert.deepEqual(showNotesLinks({ url: THREAD }), { threadUrl: THREAD, articleUrl: null })
})

test('a release is never created without the thread link for its notes', async () => {
  const client = new SleeperHit({ baseUrl: 'https://example.test', apiKey: 'test' })
  const calls = []
  client.request = async (path, options = {}) => { calls.push({ path, options }); return { releases: [], nextCursor: null } }
  await assert.rejects(
    () => client.publishEpisode('series_1', { title: 'Episode', artifactId: 'artifact_1', idempotencyKeyPrefix: 'p' }),
    /Hacker News thread link/,
  )
  assert.deepEqual(calls, [], 'nothing is read, created or published')
})

test('the notes are written onto the release before it is published, from the generated sentence', async () => {
  const client = new SleeperHit({ baseUrl: 'https://example.test', apiKey: 'test' })
  const calls = []
  client.request = async (path, options = {}) => {
    calls.push({ path, method: options.method || 'GET', body: options.body })
    if (path.includes('/releases?')) return { releases: [], nextCursor: null }
    if (path === '/publishing-series/series_1/releases') return { release: { id: 'release_1' } }
    if (path.endsWith('/description/generate')) return { release: { id: 'release_1', description: 'Tabs versus spaces, again.' } }
    return {}
  }
  await client.publishEpisode('series_1', {
    title: 'Episode', artifactId: 'artifact_1', idempotencyKeyPrefix: 'p',
    showNotes: { threadUrl: THREAD, articleUrl: 'https://publisher.example/story' },
  })
  const order = calls.map((call) => `${call.method} ${call.path}`)
  assert.ok(order.indexOf('PATCH /publishing-releases/release_1') < order.indexOf('POST /publishing-releases/release_1/publish'))
  const patch = calls.find((call) => call.method === 'PATCH')
  assert.equal(patch.body.description, composeShowNotes('Tabs versus spaces, again.', { threadUrl: THREAD, articleUrl: 'https://publisher.example/story' }))
})
