import test from 'node:test'
import assert from 'node:assert/strict'

import { deathThreadMatch, deathThreadReason } from '../worker/death-thread.mjs'

// A real person's death, in the title alone.
const DEATH_TITLES = [
  'Bob Cringely Has Died',
  'Tell HN: Bob Cringely has died',
  'Bill Draper has died',
  'Kris Kristofferson dies at 88',
  'Gordon Moore, Intel co-founder, dies aged 94',
  'Niklaus Wirth, creator of the Pascal language, has died',
  'Obituary: Frances E. Allen',
  'In Memoriam: Larry Tesler',
  'Physicist Freeman Dyson died',
  'RIP Kevin Mitnick, hacker and author',
  'R.I.P. Professor Ross Anderson',
  'Remembering Larry Tesler, inventor of cut and paste',
  'Dennis Ritchie (1941–2011)',
  'Tell HN: Frances E. Allen (1932-2020)',
  'Milt Windler, NASA flight director who helped save Apollo 13, dies at 94',
  'Funeral held for Unix pioneer Joe Ossanna',
  'Tell HN: My father passed away and I need to shut down his servers',
  'Sir Clive Sinclair has died',
  'Mark Stevens, the man behind Robert X. Cringely, has sadly died',
]

// A product's or a project's "death", and words that only look like it.
const NOT_DEATH_TITLES = [
  'Python 2 is dead',
  'The death of Google Reader',
  'RIP Google Reader',
  'How Flash died',
  'Why my startup died',
  'My startup has died: a postmortem',
  'Python 2 has died',
  'Ask HN: My laptop has died, what should I buy?',
  'The day the music died',
  'Memorial Day sale: 50% off every ebook',
  'Scanning the Lincoln Memorial in 3D',
  'A funeral for Windows XP',
  'Firefox is dying',
  'Dead code elimination in Rust',
  "Show HN: A dead man's switch for your passwords",
  'rip out your ORM and write SQL',
  'Students studied how batteries degrade',
  'Agents don\'t need memory, they need documentation',
  'The language that died at birth',
  'Google Reader (2005–2013)',
  // A Stanford Encyclopedia of Philosophy entry's publication history (HN top 75, 2026-10-04).
  'Holes (1996-2025)',
  'We\'re working on a new RuneScape MMO',
  'Treachery in the Rodin Museum 3D scan verdict',
]

test('a real person\'s death in the title is a death thread', () => {
  for (const title of DEATH_TITLES) {
    const match = deathThreadMatch({ title })
    assert.ok(match, `expected a death thread: ${title}`)
    assert.equal(match.field, 'title')
  }
})

test('a product\'s death, and words that only look like one, are not death threads', () => {
  for (const title of NOT_DEATH_TITLES) {
    assert.equal(deathThreadMatch({ title }), null, `not a death thread: ${title}`)
  }
})

test('the self-post can say it when the title does not', () => {
  // Episode 4's own self-post (2026-10-04), under a neutral title.
  const match = deathThreadMatch({
    title: 'Bob Cringely',
    storyText: 'I heard from a friend of the family that Bob passed away in his sleep early Saturday. Very sad news.',
  })
  assert.equal(match.field, 'self-post')
  assert.equal(match.phrase, 'passed away')
})

test('the linked article\'s headline or opening can say it when the title does not', () => {
  const byHeadline = deathThreadMatch({ title: 'Bill Draper', articleTitle: 'William Draper, Venture Capitalist, Dies at 98' })
  assert.equal(byHeadline.field, 'article headline')
  const byLede = deathThreadMatch({
    title: 'A life in venture capital',
    articleText: 'William H. Draper III, a pioneer of Silicon Valley venture capital, has died. He was 98.',
  })
  assert.equal(byLede.field, 'article')
  assert.equal(byLede.phrase, 'has died')
})

test('a death mentioned deep in an article body is not a death thread, and a product\'s death in prose is not one', () => {
  const longArticle = `${'This article is about compilers and register allocation. '.repeat(20)}The author passed away in 2019.`
  assert.equal(deathThreadMatch({ title: 'Register allocation, explained', articleText: longArticle }), null)
  assert.equal(deathThreadMatch({
    title: 'What happened to our app',
    articleText: 'Our sync service has died twice this year, and here is why we rebuilt it.',
  }), null)
})

test('the pass-over reason names the phrase and where it was found', () => {
  const reason = deathThreadReason(deathThreadMatch({ title: 'Tell HN: Bob Cringely has died' }))
  assert.match(reason, /^death thread/)
  assert.match(reason, /"has died" in the title/)
})

test('nothing to read is not a death thread', () => {
  assert.equal(deathThreadMatch(), null)
  assert.equal(deathThreadMatch({ title: '', storyText: null, articleTitle: undefined, articleText: '' }), null)
})
