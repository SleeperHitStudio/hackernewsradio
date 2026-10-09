import assert from 'node:assert/strict'
import test from 'node:test'

import {
  COMMENTER_GIVEN_NAMES,
  COMMENTER_SURNAMES,
  DEV_PSEUDONYM_KEY,
  GIVEN_NAME_DRAWS,
  buildPseudonymMap,
  isDistinctiveHandle,
  makeTextPseudonymizer,
  outsideMentions,
  pseudonymFor,
  pseudonymizeThread,
  resolvePseudonymKey,
} from '../worker/pseudonyms.mjs'
import { HOSTS } from '../worker/brief.mjs'

const KEY = 'hnr-test-pseudonym-key-0123456789'
const OTHER_KEY = 'hnr-other-pseudonym-key-9876543210'
const GIVEN = new Set(COMMENTER_GIVEN_NAMES)
const isGivenName = (name) => GIVEN.has(name)
const isFullName = (name) => {
  const [given, surname, ...rest] = name.split(' ')
  return rest.length === 0 && GIVEN.has(given) && COMMENTER_SURNAMES.includes(surname)
}

test('the names are plain, sayable given names: no digits, no compound handles, no host, no repeats', () => {
  for (const list of [COMMENTER_GIVEN_NAMES, COMMENTER_SURNAMES]) {
    assert.equal(new Set(list).size, list.length, 'no duplicates')
    for (const name of list) assert.match(name, /^[A-Z][a-z]+$/, name)
  }
  assert.ok(COMMENTER_GIVEN_NAMES.length >= 120)
  const hosts = new Set(HOSTS.map((host) => host.name.toLowerCase()))
  for (const name of COMMENTER_GIVEN_NAMES) assert.ok(!hosts.has(name.toLowerCase()), `${name} is a host`)
  assert.ok(COMMENTER_GIVEN_NAMES.every((name) => !COMMENTER_SURNAMES.includes(name)), 'a surname is never a given name')
})

test('a username draws the same name under the same key; another key draws independently', async () => {
  const first = await pseudonymFor('tptacek', KEY)
  assert.equal(await pseudonymFor('tptacek', KEY), first)
  assert.ok(isGivenName(first), `${first} is a plain given name`)
  const draws = await Promise.all(['a1', 'b2', 'c3', 'd4', 'e5', 'f6', 'g7', 'h8'].map((h) => pseudonymFor(h, KEY)))
  const otherDraws = await Promise.all(['a1', 'b2', 'c3', 'd4', 'e5', 'f6', 'g7', 'h8'].map((h) => pseudonymFor(h, OTHER_KEY)))
  assert.notDeepEqual(draws, otherDraws, 'without the key, a username\'s name cannot be recomputed')
  assert.ok(isFullName(await pseudonymFor('tptacek', KEY, GIVEN_NAME_DRAWS)), 'late draws are a given name and a surname')
  await assert.rejects(() => pseudonymFor('x', ''), /naming key is required/)
})

test('within one episode each commenter has one name and no two share one, whatever the order', async () => {
  const handles = Array.from({ length: 60 }, (_, i) => `user${i}`)
  const map = await buildPseudonymMap(handles, KEY)
  const names = [...map.values()]
  assert.equal(map.size, handles.length)
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, names.length, 'distinct names')
  assert.ok(names.every(isGivenName), 'a thread this size is all plain given names')
  const reversed = await buildPseudonymMap([...handles].reverse(), KEY)
  assert.deepEqual([...reversed.entries()].sort(), [...map.entries()].sort(), 'the order comments arrive in changes nothing')
  // Without a collision, a commenter keeps the name they draw in any thread.
  const alone = await buildPseudonymMap(['tptacek'], KEY)
  assert.equal(alone.get('tptacek'), await pseudonymFor('tptacek', KEY))
})

test('a thread with more commenters than given names falls back to given name and surname, still distinct', async () => {
  const handles = Array.from({ length: COMMENTER_GIVEN_NAMES.length + 200 }, (_, i) => `member_${i}`)
  const map = await buildPseudonymMap(handles, KEY)
  const names = [...map.values()]
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, handles.length)
  assert.ok(names.every((name) => isGivenName(name) || isFullName(name)))
  assert.equal(names.filter(isGivenName).length, COMMENTER_GIVEN_NAMES.length, 'every given name is used before any full name')
})

test('a name never equals a real username in the thread', async () => {
  const drawn = await pseudonymFor('collider', KEY)
  // Someone in the thread is literally called what "collider" draws.
  const map = await buildPseudonymMap(['collider', drawn.toLowerCase()], KEY)
  for (const name of map.values()) assert.notEqual(name.toLowerCase(), drawn.toLowerCase())
})

test('bare-word mentions are replaced only for distinctive usernames', () => {
  for (const handle of ['patio11', 'some_user', 'jane-doe', 'quietDev', 'Animats', 'longhandle']) {
    assert.equal(isDistinctiveHandle(handle), true, handle)
  }
  for (const handle of ['dang', 'sama', 'pg', 'the', 'throw']) {
    assert.equal(isDistinctiveHandle(handle), false, handle)
  }
})

test('mentions in text: thread members and outsiders by their episode names; code and email untouched', async () => {
  const texts = ['As patio11 said, and @Patio11 agreed.', '@dang please fix. Dang, that is slow.', 'cc @someone_new and @someone_new']
  const members = ['patio11', 'dang']
  assert.deepEqual(outsideMentions([...texts, 'Use @media and @types/node'], members), ['someone_new'])
  const map = await buildPseudonymMap([...members, 'someone_new'], KEY)
  const rename = makeTextPseudonymizer(map)
  const [patio, dang, outsider] = [map.get('patio11'), map.get('dang'), map.get('someone_new')]
  assert.equal(new Set([patio, dang, outsider]).size, 3, 'an outsider never shares a member\'s name')

  assert.equal(rename(texts[0]), `As ${patio} said, and @${patio} agreed.`)
  assert.equal(rename(texts[1]), `@${dang} please fix. Dang, that is slow.`, 'a plain-word username is replaced only in its @ form (known limit)')
  assert.equal(rename(texts[2]), `cc @${outsider} and @${outsider}`)
  const code = 'Use @media queries, @Override, @property and @types/node; mail me at me@patio11.com.'
  assert.equal(rename(code), code, 'code at-keywords, scoped packages and email addresses are not mentions')
  assert.ok(!rename('github.com/patio11/repo').includes('patio11'), 'a URL path is renamed too')
  assert.equal(rename('patio11x and xpatio11 are other words'), 'patio11x and xpatio11 are other words')
})

test('pseudonymizeThread renames authors, the submitter and the self-post, and marks the thread', async () => {
  const thread = {
    id: '1',
    title: 'Ask HN: anything',
    author: 'submitter_1',
    storyText: 'Thanks @quietDev for the idea; ping @outsider_9',
    total: 2,
    comments: [
      { id: '2', author: 'quietDev', text: 'submitter_1 is right' },
      { id: '3', author: 'submitter_1', text: 'thanks quietDev' },
    ],
  }
  const out = await pseudonymizeThread(thread, KEY)
  const map = await buildPseudonymMap(['quietDev', 'submitter_1', 'outsider_9'], KEY)
  const [sub, quiet, outsider] = [map.get('submitter_1'), map.get('quietDev'), map.get('outsider_9')]
  assert.equal(out.pseudonymized, true)
  assert.equal(out.author, sub)
  assert.equal(out.storyText, `Thanks @${quiet} for the idea; ping @${outsider}`)
  assert.deepEqual(out.comments.map((c) => [c.author, c.text]), [[quiet, `${sub} is right`], [sub, `thanks ${quiet}`]])
  assert.equal(thread.comments[0].author, 'quietDev', 'the input is not mutated')
  const serialized = JSON.stringify(out)
  for (const handle of ['submitter_1', 'quietDev', 'outsider_9']) assert.ok(!serialized.includes(handle), `${handle} leaked`)
  await assert.rejects(() => pseudonymizeThread(thread, ''), (error) => error.code === 'pseudonym_key_missing')
})

test('the key: a secret wherever episodes can be made, the development key only where they cannot', () => {
  assert.equal(resolvePseudonymKey({ HNR_PSEUDONYM_KEY: KEY, SLEEPERHIT_API_KEY: 'sh_live' }), KEY)
  assert.equal(resolvePseudonymKey({}), DEV_PSEUDONYM_KEY)
  assert.equal(resolvePseudonymKey({ SLEEPERHIT_API_KEY: '  ' }), DEV_PSEUDONYM_KEY)
  assert.throws(() => resolvePseudonymKey({ SLEEPERHIT_API_KEY: 'sh_live' }), (error) => error.code === 'pseudonym_key_missing')
  assert.throws(() => resolvePseudonymKey({ HNR_PSEUDONYM_KEY: 'short' }), /at least 16 characters/)
})
