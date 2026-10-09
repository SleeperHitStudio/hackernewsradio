import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEV_PSEUDONYM_KEY,
  PSEUDONYM_ADJECTIVES,
  PSEUDONYM_NOUNS,
  buildPseudonymMap,
  isDistinctiveHandle,
  makeTextPseudonymizer,
  pseudonymFor,
  pseudonymizeThread,
  resolvePseudonymKey,
} from '../worker/pseudonyms.mjs'

const KEY = 'hnr-test-pseudonym-key-0123456789'
const OTHER_KEY = 'hnr-other-pseudonym-key-9876543210'

test('a username always gets the same pseudonym under the same key, in every thread', async () => {
  const first = await pseudonymFor('tptacek', KEY)
  assert.equal(await pseudonymFor('tptacek', KEY), first)
  assert.match(first, /^[A-Z][a-z]+[A-Z][a-z]+\d{2}$/, 'two plain words and a number')
  const inOneThread = await buildPseudonymMap(['tptacek', 'patio11'], KEY)
  const inAnother = await buildPseudonymMap(['someone_else', 'tptacek', 'third-user'], KEY)
  assert.equal(inOneThread.get('tptacek'), first)
  assert.equal(inAnother.get('tptacek'), first, 'a running bit about one commenter stays coherent across episodes')
})

test('a pseudonym depends on the key and never contains the username', async () => {
  const a = await pseudonymFor('rustacean42', KEY)
  const b = await pseudonymFor('rustacean42', OTHER_KEY)
  assert.notEqual(a, b, 'without the key, the pseudonym cannot be recomputed from the username')
  assert.ok(!a.toLowerCase().includes('rustacean'))
  await assert.rejects(() => pseudonymFor('x', ''), /pseudonym key is required/)
})

test('the word lists are plain, distinct words', () => {
  for (const list of [PSEUDONYM_ADJECTIVES, PSEUDONYM_NOUNS]) {
    assert.equal(new Set(list).size, list.length, 'no duplicates')
    assert.ok(list.length >= 128)
    for (const word of list) assert.match(word, /^[A-Z][a-z]+$/)
  }
})

test('two usernames in one thread never share a pseudonym, and none is a real username in the thread', async () => {
  const handles = Array.from({ length: 3000 }, (_, i) => `user${i}`)
  const map = await buildPseudonymMap(handles, KEY)
  const names = [...map.values()]
  assert.equal(map.size, handles.length)
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, names.length, 'every commenter keeps a distinct name')
  // Force the collision path: a real username that equals another's first draw.
  const victim = await pseudonymFor('collider', KEY)
  const forced = await buildPseudonymMap(['collider', victim], KEY)
  assert.notEqual(forced.get('collider'), victim, 'a pseudonym never names a real participant')
  assert.notEqual(forced.get(victim), victim)
  assert.equal(forced.get('collider'), await pseudonymFor('collider', KEY, 1), 'the collision is settled deterministically')
  // The order comments arrive in does not change who keeps what.
  const reversed = await buildPseudonymMap([...handles].reverse(), KEY)
  assert.deepEqual([...reversed.entries()].sort(), [...map.entries()].sort())
})

test('bare-word mentions are replaced only for distinctive usernames', () => {
  for (const handle of ['patio11', 'some_user', 'jane-doe', 'quietDev', 'Animats', 'longhandle']) {
    assert.equal(isDistinctiveHandle(handle), true, handle)
  }
  for (const handle of ['dang', 'sama', 'pg', 'the', 'throw']) {
    assert.equal(isDistinctiveHandle(handle), false, handle)
  }
})

test('mentions in text: thread members by their pseudonym, outsiders by their own, code and email untouched', async () => {
  const map = await buildPseudonymMap(['patio11', 'dang'], KEY)
  const rename = makeTextPseudonymizer(map, KEY)
  const patio = map.get('patio11')
  const dang = map.get('dang')
  const outsider = await pseudonymFor('someone_new', KEY)

  assert.equal(await rename('As patio11 said, and @Patio11 agreed.'), `As ${patio} said, and @${patio} agreed.`)
  assert.equal(await rename('@dang please fix. Dang, that is slow.'), `@${dang} please fix. Dang, that is slow.`, 'a plain-word name is replaced only in its @ form')
  assert.equal(await rename('cc @someone_new and @someone_new'), `cc @${outsider} and @${outsider}`)
  const code = 'Use @media queries, @Override, @property and @types/node; mail me at me@patio11.com.'
  assert.equal(await rename(code), code, 'code at-keywords, scoped packages and email addresses are not mentions')
  assert.ok(!(await rename('github.com/patio11/repo')).includes('patio11'), 'a URL path is renamed too')
  assert.equal(await rename('patio11x and xpatio11 are other words'), 'patio11x and xpatio11 are other words')
})

test('pseudonymizeThread renames authors, the submitter and the self-post, and marks the thread', async () => {
  const thread = {
    id: '1',
    title: 'Ask HN: anything',
    author: 'submitter_1',
    storyText: 'Thanks @quietDev for the idea',
    total: 2,
    comments: [
      { id: '2', author: 'quietDev', text: 'submitter_1 is right' },
      { id: '3', author: 'submitter_1', text: 'thanks quietDev' },
    ],
  }
  const out = await pseudonymizeThread(thread, KEY)
  const sub = await pseudonymFor('submitter_1', KEY)
  const quiet = await pseudonymFor('quietDev', KEY)
  assert.equal(out.pseudonymized, true)
  assert.equal(out.author, sub)
  assert.equal(out.storyText, `Thanks @${quiet} for the idea`)
  assert.deepEqual(out.comments.map((c) => [c.author, c.text]), [[quiet, `${sub} is right`], [sub, `thanks ${quiet}`]])
  assert.equal(thread.comments[0].author, 'quietDev', 'the input is not mutated')
  const serialized = JSON.stringify(out)
  for (const handle of ['submitter_1', 'quietDev']) assert.ok(!serialized.includes(handle), `${handle} leaked`)
  await assert.rejects(() => pseudonymizeThread(thread, ''), (error) => error.code === 'pseudonym_key_missing')
})

test('the key: a secret wherever episodes can be made, the development key only where they cannot', () => {
  assert.equal(resolvePseudonymKey({ HNR_PSEUDONYM_KEY: KEY, SLEEPERHIT_API_KEY: 'sh_live' }), KEY)
  assert.equal(resolvePseudonymKey({}), DEV_PSEUDONYM_KEY)
  assert.equal(resolvePseudonymKey({ SLEEPERHIT_API_KEY: '  ' }), DEV_PSEUDONYM_KEY)
  assert.throws(() => resolvePseudonymKey({ SLEEPERHIT_API_KEY: 'sh_live' }), (error) => error.code === 'pseudonym_key_missing')
  assert.throws(() => resolvePseudonymKey({ HNR_PSEUDONYM_KEY: 'short' }), /at least 16 characters/)
})
