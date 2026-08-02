import test from 'node:test'
import assert from 'node:assert/strict'

import { fetchArticle, threadToTranscript } from '../worker/hn.mjs'

const baseThread = {
  id: '1',
  title: 'Tailscale didn\'t stop the Hugging Face intrusion',
  url: 'https://news.ycombinator.com/item?id=1',
  author: 'bluehatbrit',
  points: 597,
  storyText: '',
  total: 2,
  comments: [
    { id: 'c1', author: 'alice', depth: 0, text: 'This is a nothingburger.', parentId: null },
    { id: 'c2', author: 'bob', depth: 1, text: 'Disagree, the blast radius matters.', parentId: 'c1' },
  ],
}

test('the source article is rendered BEFORE any comment', () => {
  // Episodes consistently cold-opened into the bickering because the writer met
  // the reactions before the thing being reacted to. Order is the fix.
  const transcript = threadToTranscript({
    ...baseThread,
    articleUrl: 'https://tailscale.com/blog/hugging-face-intrusion',
    article: { url: 'https://tailscale.com/blog/hugging-face-intrusion', text: 'ARTICLE BODY HERE', truncated: false },
  })

  const sourceAt = transcript.indexOf('## THE SOURCE')
  const bodyAt = transcript.indexOf('ARTICLE BODY HERE')
  const commentsAt = transcript.indexOf('## Comments')

  assert.ok(sourceAt > -1, 'the source section must be present')
  assert.ok(bodyAt > -1, 'the article body must be included')
  assert.ok(sourceAt < commentsAt, 'the source must come before the comments')
  assert.ok(bodyAt < commentsAt, 'the article body must come before the comments')
  assert.match(transcript, /Source article: https:\/\/tailscale\.com/)
})

test('an unfetchable article says so instead of going silent', () => {
  // Silence reads as "there was no article", and the writer then invents one
  // from the headline with total confidence. Naming the gap is the guard.
  const transcript = threadToTranscript({
    ...baseThread,
    articleUrl: 'https://paywalled.example/story',
    article: null,
  })

  assert.match(transcript, /## THE SOURCE — could not be retrieved/)
  assert.match(transcript, /paywall, bot block, or a JS-only page/)
  assert.match(transcript, /Do NOT invent specifics/)
  assert.ok(
    transcript.indexOf('## THE SOURCE') < transcript.indexOf('## Comments'),
    'even the failure notice belongs ahead of the comments',
  )
})

test('a self-post with no external link gets no source section at all', () => {
  // Ask HN and similar carry their subject in storyText; inventing an empty
  // "source" section there would just be noise.
  const transcript = threadToTranscript({
    ...baseThread,
    articleUrl: null,
    article: null,
    storyText: 'Ask HN: how do you test workers?',
  })

  assert.ok(!transcript.includes('## THE SOURCE'), 'no source section without a link')
  assert.match(transcript, /## Original post/)
})

test('fetchArticle rejects non-http inputs without a network call', async () => {
  // Guards run before fetch, so these must not throw or hang.
  for (const bad of [null, undefined, '', 'ftp://x/y', 'javascript:alert(1)', 'not a url']) {
    assert.equal(await fetchArticle(bad), null, `expected null for ${JSON.stringify(bad)}`)
  }
})

test('a truncated article is marked so the hosts know it is partial', () => {
  const transcript = threadToTranscript({
    ...baseThread,
    articleUrl: 'https://example.com/long',
    article: { url: 'https://example.com/long', text: 'BEGIN\n\n[HNR ARTICLE TRUNCATED]', truncated: true },
  })
  assert.match(transcript, /\[HNR ARTICLE TRUNCATED\]/)
})
