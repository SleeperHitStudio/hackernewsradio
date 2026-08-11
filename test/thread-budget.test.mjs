import assert from 'node:assert/strict'
import test from 'node:test'

import { buildSourceMetadata, HNError, threadToTranscript } from '../worker/hn.mjs'

const makeComments = (count, { length = 180 } = {}) =>
  Array.from({ length: count }, (_, index) => ({
    id: String(index + 1),
    parentId: index === 0 ? null : String(index),
    branch: '1',
    author: `user${index}`,
    depth: Math.min(index, 8),
    text: `${'x'.repeat(length)}\nparagraph-${index}`,
  }))

function makeThread(comments, overrides = {}) {
  return {
    id: '42',
    title: 'A complete thread',
    url: 'https://news.ycombinator.com/item?id=42',
    articleUrl: null,
    author: 'op',
    points: 10,
    storyText: '',
    comments,
    total: comments.length,
    completeness: {
      comments: {
        complete: true,
        expected: comments.length,
        fetched: comments.length,
        capturedAt: '2026-08-10T12:00:00.000Z',
        metadataSource: 'official-hn-firebase',
        contentSource: 'hn-algolia-search-plus-recursive-item-tree',
      },
    },
    ...overrides,
  }
}

test('an ordinary thread arrives complete without excerpts', () => {
  const comments = makeComments(333)
  const transcript = threadToTranscript(makeThread(comments))

  assert.match(transcript, /COMPLETE COMMENT THREAD \(all 333 comments\)/)
  assert.match(transcript, /<<<HNR_COMMENTS_BEGIN count=333>>>/)
  assert.match(transcript, /<<<HNR_COMMENTS_END>>>/)
  assert.match(transcript, /\[comment=333 reply_to=332\] user332:/)
  assert.match(transcript, /paragraph-332/)
})

test('source metadata opts Sleeper Hit into exact full-text grounding', () => {
  const thread = makeThread(makeComments(3))
  const transcript = threadToTranscript(thread)
  const metadata = buildSourceMetadata(thread, transcript)

  assert.equal(metadata.sourceProducer, 'hackernewsradio')
  assert.equal(metadata.sourceContextMode, 'full')
  assert.equal(metadata.hnStoryId, '42')
  assert.deepEqual(metadata.sourceCompleteness.comments, {
    complete: true,
    expected: 3,
    fetched: 3,
    capturedAt: '2026-08-10T12:00:00.000Z',
    metadataSource: 'official-hn-firebase',
    contentSource: 'hn-algolia-search-plus-recursive-item-tree',
  })
  assert.equal(metadata.sourceCompleteness.article.required, false)
  assert.equal(metadata.sourceCompleteness.post.required, false)
  assert.equal(metadata.sourceCompleteness.sourcePack.chars, transcript.length)
  assert.equal(metadata.sourceCompleteness.sourcePack.clipped, false)
})

test('the formerly sampled 1,057-comment case keeps every comment and long body', () => {
  const comments = makeComments(1_057, { length: 600 })
  comments[1_056].text = `${'z'.repeat(2_400)}\nlong-comment-end`
  const transcript = threadToTranscript(makeThread(comments))

  assert.match(transcript, /\[comment=1057 reply_to=1056\] user1056:/)
  assert.ok(transcript.includes('z'.repeat(2_400)), 'comment text must not be clipped at the old 1,600-character cap')
  assert.match(transcript, /long-comment-end/)
})

test('a complete self-post is not clipped at the old 1,500-character cap', () => {
  const storyText = `BEGIN-${'s'.repeat(8_000)}-END`
  const transcript = threadToTranscript(makeThread([], { storyText }))

  assert.ok(transcript.includes(storyText))
  assert.match(transcript, new RegExp(`<<<HNR_SELF_POST_BEGIN chars=${storyText.length}>>>`))
  assert.match(transcript, /<<<HNR_SELF_POST_END>>>/)
  assert.match(transcript, /COMPLETE COMMENT THREAD \(all 0 comments\)/)
  assert.match(transcript, /<<<HNR_COMMENTS_BEGIN count=0>>>\n\n<<<HNR_COMMENTS_END>>>/)

  const metadata = buildSourceMetadata(makeThread([], { storyText }), transcript)
  assert.deepEqual(metadata.sourceCompleteness.post, {
    required: true,
    complete: true,
    chars: storyText.length,
  })
})

test('a source above the downstream limit fails instead of sampling or clipping', () => {
  const comments = makeComments(50, { length: 2_000 })

  assert.throws(
    () => threadToTranscript(makeThread(comments), { maxChars: 10_000, maxBytes: 20_000 }),
    (error) => error instanceof HNError && error.code === 'source_pack_too_large',
  )
})

test('a count mismatch is rejected before rendering', () => {
  const comments = makeComments(2)
  const thread = makeThread(comments)
  thread.total = 3

  assert.throws(
    () => threadToTranscript(thread),
    (error) => error instanceof HNError && error.code === 'hn_thread_incomplete',
  )
})

test('missing completeness proof is rejected before rendering', () => {
  const thread = makeThread(makeComments(1))
  delete thread.completeness

  assert.throws(
    () => threadToTranscript(thread),
    (error) => error instanceof HNError && error.code === 'hn_thread_incomplete',
  )
})

test('duplicate or empty comments are rejected before rendering', () => {
  const duplicate = makeThread(makeComments(2))
  duplicate.comments[1].id = duplicate.comments[0].id
  assert.throws(() => threadToTranscript(duplicate), { code: 'hn_thread_incomplete' })

  const empty = makeThread(makeComments(1))
  empty.comments[0].text = ''
  assert.throws(() => threadToTranscript(empty), { code: 'hn_thread_incomplete' })
})
