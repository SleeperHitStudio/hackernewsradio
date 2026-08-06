import assert from 'node:assert/strict'
import test from 'node:test'

import {
  TRANSCRIPT_COMMENT_BUDGET,
  TRANSCRIPT_MAX_CHARS_EACH,
  TRANSCRIPT_MIN_CHARS_EACH,
  planCommentBudget,
  threadToTranscript,
} from '../worker/hn.mjs'

/**
 * Real HN shape, measured off three threads this show has covered: the median
 * comment is ~160 characters, p90 lands near 500, and under 1% run past 1600.
 */
const makeComments = (count, { length = 180 } = {}) =>
  Array.from({ length: count }, (_, i) => ({
    id: String(i + 1),
    parentId: null,
    branch: i % 12,
    author: `user${i}`,
    depth: 0,
    text: 'x'.repeat(length),
  }))

test('an ordinary thread arrives complete and untouched', () => {
  // 333 comments was the largest of the threads measured; it must not be
  // excerpted at all, let alone truncated to 240.
  const plan = planCommentBudget(makeComments(333))
  assert.equal(plan.comments.length, 333)
  assert.equal(plan.charsEach, TRANSCRIPT_MAX_CHARS_EACH)
  assert.equal(plan.complete, true)
})

test('the thread that lost 77% of itself now arrives whole', () => {
  // The GPT-5.6 thread: 1057 comments, of which the writer previously saw 240.
  const plan = planCommentBudget(makeComments(1057))
  assert.equal(plan.comments.length, 1057)
  assert.equal(plan.complete, true)
})

test('a huge thread tightens excerpts rather than dropping commenters', () => {
  // Long comments AND many of them: the budget binds, so per-comment length
  // gives way first. Every commenter still appears.
  const comments = makeComments(1200, { length: 1500 })
  const plan = planCommentBudget(comments)
  assert.equal(plan.comments.length, 1200, 'nobody is dropped')
  assert.equal(plan.complete, true)
  assert.ok(plan.charsEach < TRANSCRIPT_MAX_CHARS_EACH, 'excerpts tightened')
  assert.ok(plan.charsEach >= TRANSCRIPT_MIN_CHARS_EACH, 'never below the readable floor')
})

test('the chosen allowance actually fits the budget, and is the largest that does', () => {
  const comments = makeComments(1200, { length: 1500 })
  const plan = planCommentBudget(comments)
  const cost = (each) => comments.reduce((sum, c) => sum + Math.min(c.text.length, each), 0)
  assert.ok(cost(plan.charsEach) <= TRANSCRIPT_COMMENT_BUDGET, 'fits')
  // One character more must not fit, or we gave away detail we could afford.
  assert.ok(cost(plan.charsEach + 1) > TRANSCRIPT_COMMENT_BUDGET, 'maximal')
})

test('only a thread past the readable floor loses comments, and says so', () => {
  // Big enough that even minimum-length excerpts cannot all fit.
  const comments = makeComments(4000, { length: 2000 })
  const plan = planCommentBudget(comments)
  assert.equal(plan.complete, false)
  assert.ok(plan.comments.length < 4000)
  assert.equal(plan.charsEach, TRANSCRIPT_MIN_CHARS_EACH)
  // Breadth is preserved: the sample spans top-level branches, not one prefix.
  assert.ok(new Set(plan.comments.map((c) => c.branch)).size > 1)
})

test('an empty thread is handled without dividing by zero', () => {
  const plan = planCommentBudget([])
  assert.deepEqual(plan.comments, [])
  assert.equal(plan.complete, true)
})

test('the transcript claims completeness only when it is complete', () => {
  const thread = {
    title: 'A thread', url: 'https://news.ycombinator.com/item?id=1',
    author: 'op', points: 10, storyText: '', articleUrl: null,
    comments: makeComments(50), total: 50,
  }
  const complete = threadToTranscript(thread)
  assert.match(complete, /this is the ENTIRE thread/)
  assert.doesNotMatch(complete, /sampled across top-level branches/)

  // Forcing a tiny budget makes it incomplete, and it must admit that.
  const sampled = threadToTranscript(
    { ...thread, comments: makeComments(400, { length: 900 }), total: 400 },
    { budget: 20_000 },
  )
  assert.match(sampled, /sampled across top-level branches/)
  assert.doesNotMatch(sampled, /this is the ENTIRE thread/)
})

test('every included comment is rendered with its handle and id', () => {
  const thread = {
    title: 'A thread', url: 'https://news.ycombinator.com/item?id=1',
    author: 'op', points: 10, storyText: '', articleUrl: null,
    comments: makeComments(300), total: 300,
  }
  const transcript = threadToTranscript(thread)
  // Previously the 241st comment onward simply did not exist for the writer.
  assert.ok(transcript.includes('user299:'), 'the 300th comment is present')
  assert.ok(transcript.includes('[comment=300'), 'and carries its id for quoting')
})
