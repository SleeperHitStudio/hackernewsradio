import assert from 'node:assert/strict'
import test from 'node:test'

import { fetchThread, HNError } from '../worker/hn.mjs'

const json = (value) => new Response(JSON.stringify(value), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})

function comment(id, parentId, text, createdAt, storyId) {
  return {
    objectID: String(id),
    parent_id: parentId,
    story_id: storyId,
    author: `user${id}`,
    comment_text: text,
    created_at_i: createdAt,
  }
}

test('fetchThread paginates every comment and reconstructs reply order', async () => {
  const requestedCursors = []
  const fetchImpl = async (input) => {
    const url = new URL(String(input))
    if (url.hostname === 'hacker-news.firebaseio.com') {
      return json({
        id: 100,
        type: 'story',
        title: 'A &amp; B',
        by: 'op',
        score: 42,
        descendants: 3,
        url: 'https://example.com/article',
      })
    }
    if (url.pathname === '/api/v1/items/100') {
      return json({
        id: 100,
        children: [
          { id: 11, children: [{ id: 12, children: [] }] },
          { id: 13, children: [] },
        ],
      })
    }
    if (url.pathname === '/api/v1/search_by_date') {
      const cursor = url.searchParams.get('numericFilters')
      requestedCursors.push(cursor)
      assert.equal(url.searchParams.get('tags'), 'comment,story_100')
      if (!cursor) {
        return json({
          nbHits: 3,
          nbPages: 1,
          hits: [
            comment(12, 11, '<p>reply body</p>', 20, 100),
            comment(13, 100, '<p>second branch</p>', 30, 100),
          ],
        })
      }
      assert.equal(cursor, 'created_at_i<=20')
      return json({
        nbHits: 2,
        nbPages: 1,
        hits: [
          comment(12, 11, '<p>reply body</p>', 20, 100),
          comment(11, 100, '<p>first <a href="https://example.com">link</a></p>', 10, 100),
        ],
      })
    }
    throw new Error(`Unexpected URL: ${url}`)
  }

  const thread = await fetchThread('100', { fetchImpl, maxAttempts: 1 })

  assert.deepEqual(requestedCursors, [null, 'created_at_i<=20'])
  assert.equal(thread.title, 'A & B')
  assert.equal(thread.total, 3)
  assert.deepEqual(thread.comments.map(({ id, parentId, depth }) => ({ id, parentId, depth })), [
    { id: '11', parentId: null, depth: 0 },
    { id: '12', parentId: '11', depth: 1 },
    { id: '13', parentId: null, depth: 0 },
  ])
  assert.equal(thread.comments[0].text, 'first link (https://example.com)')
  assert.deepEqual(thread.completeness.comments, {
    complete: true,
    expected: 3,
    fetched: 3,
    capturedAt: thread.completeness.comments.capturedAt,
    metadataSource: 'official-hn-firebase',
    contentSource: 'hn-algolia-search-plus-recursive-item-tree',
  })
})

test('fetchThread merges recursive-tree overflow beyond the search result cap', async () => {
  const fetchImpl = async (input) => {
    const url = new URL(String(input))
    if (url.hostname === 'hacker-news.firebaseio.com') {
      return json({ id: 150, type: 'story', title: 'Large thread', by: 'op', descendants: 3 })
    }
    if (url.pathname === '/api/v1/items/150') {
      return json({
        id: 150,
        children: [
          { id: 151, parent_id: 150, author: 'one', text: 'first', children: [] },
          { id: 152, parent_id: 150, author: 'two', text: 'overflow body', children: [
            { id: 153, parent_id: 152, author: 'three', text: 'overflow reply', children: [] },
          ] },
        ],
      })
    }
    if (url.pathname === '/api/v1/search_by_date') {
      // Mirrors Algolia's real paginationLimitedTo behavior: nbHits reports
      // the full count while the search pages expose only the capped prefix.
      return json({
        nbHits: 3,
        nbPages: 1,
        hits: [
          comment(151, 150, 'first', 1, 150),
          comment(152, 150, 'overflow body', 2, 150),
        ],
      })
    }
    throw new Error(`Unexpected URL: ${url}`)
  }

  const thread = await fetchThread('150', { fetchImpl, maxAttempts: 1 })

  assert.equal(thread.total, 3)
  assert.deepEqual(thread.comments.map(({ id, parentId }) => ({ id, parentId })), [
    { id: '151', parentId: null },
    { id: '152', parentId: null },
    { id: '153', parentId: '152' },
  ])
  assert.equal(thread.comments[2].text, 'overflow reply')
})

test('fetchThread resolves a comment URL to the root story first', async () => {
  const officialIds = []
  const fetchImpl = async (input) => {
    const url = new URL(String(input))
    if (url.hostname === 'hacker-news.firebaseio.com') {
      const id = url.pathname.match(/item\/(\d+)\.json/)?.[1]
      officialIds.push(id)
      if (id === '201') return json({ id: 201, type: 'comment', parent: 200 })
      return json({ id: 200, type: 'story', title: 'Root story', by: 'op', descendants: 0 })
    }
    if (url.pathname === '/api/v1/items/200') return json({ id: 200, children: [] })
    if (url.pathname === '/api/v1/search_by_date') return json({ nbHits: 0, nbPages: 0, hits: [] })
    throw new Error(`Unexpected URL: ${url}`)
  }

  const thread = await fetchThread('https://news.ycombinator.com/item?id=201', {
    fetchImpl,
    maxAttempts: 1,
  })

  assert.equal(thread.id, '200')
  assert.deepEqual(officialIds, ['201', '200', '200'])
})

test('fetchThread retries count disagreement and then fails closed', async () => {
  let searchCalls = 0
  const fetchImpl = async (input) => {
    const url = new URL(String(input))
    if (url.hostname === 'hacker-news.firebaseio.com') {
      return json({ id: 300, type: 'story', title: 'Changing thread', by: 'op', descendants: 2 })
    }
    if (url.pathname === '/api/v1/items/300') {
      return json({ id: 300, children: [{ id: 301, children: [] }] })
    }
    if (url.pathname === '/api/v1/search_by_date') {
      searchCalls++
      return json({ nbHits: 1, nbPages: 1, hits: [comment(301, 300, 'only one so far', 1, 300)] })
    }
    throw new Error(`Unexpected URL: ${url}`)
  }

  await assert.rejects(
    () => fetchThread('300', { fetchImpl, maxAttempts: 3, retryDelaysMs: [] }),
    (error) => {
      assert.ok(error instanceof HNError)
      assert.equal(error.code, 'hn_thread_incomplete')
      assert.deepEqual(error.details, {
        storyId: '300', expected: 2, algolia: 1, decoded: 1, attempt: 3,
      })
      return true
    },
  )
  assert.equal(searchCalls, 3)
})

test('fetchThread rejects a duplicate or body-less Algolia comment', async () => {
  const fetchImpl = async (input) => {
    const url = new URL(String(input))
    if (url.hostname === 'hacker-news.firebaseio.com') {
      return json({ id: 400, type: 'story', title: 'Broken snapshot', by: 'op', descendants: 1 })
    }
    if (url.pathname === '/api/v1/items/400') return json({ id: 400, children: [{ id: 401, children: [] }] })
    if (url.pathname === '/api/v1/search_by_date') {
      return json({ nbHits: 1, nbPages: 1, hits: [comment(401, 400, '', 1, 400)] })
    }
    throw new Error(`Unexpected URL: ${url}`)
  }

  await assert.rejects(
    () => fetchThread('400', { fetchImpl, maxAttempts: 1 }),
    (error) => error instanceof HNError && error.code === 'hn_comment_snapshot_invalid',
  )
})

test('fetchThread rejects a comment attributed to a different story', async () => {
  const fetchImpl = async (input) => {
    const url = new URL(String(input))
    if (url.hostname === 'hacker-news.firebaseio.com') {
      return json({ id: 500, type: 'story', title: 'Wrong-story hit', by: 'op', descendants: 1 })
    }
    if (url.pathname === '/api/v1/items/500') return json({ id: 500, children: [{ id: 501, children: [] }] })
    if (url.pathname === '/api/v1/search_by_date') {
      return json({ nbHits: 1, nbPages: 1, hits: [comment(501, 500, 'foreign comment', 1, 999)] })
    }
    throw new Error(`Unexpected URL: ${url}`)
  }

  await assert.rejects(
    () => fetchThread('500', { fetchImpl, maxAttempts: 1 }),
    (error) => error instanceof HNError && error.code === 'hn_comment_snapshot_invalid',
  )
})

test('fetchThread rejects a comment whose author is unavailable in both Algolia views', async () => {
  const fetchImpl = async (input) => {
    const url = new URL(String(input))
    if (url.hostname === 'hacker-news.firebaseio.com') {
      return json({ id: 600, type: 'story', title: 'Missing handle', by: 'op', descendants: 1 })
    }
    if (url.pathname === '/api/v1/items/600') {
      return json({ id: 600, children: [{ id: 601, parent_id: 600, text: 'body', children: [] }] })
    }
    if (url.pathname === '/api/v1/search_by_date') {
      return json({
        nbHits: 1,
        nbPages: 1,
        hits: [{ ...comment(601, 600, 'body', 1, 600), author: null }],
      })
    }
    throw new Error(`Unexpected URL: ${url}`)
  }

  await assert.rejects(
    () => fetchThread('600', { fetchImpl, maxAttempts: 1 }),
    (error) => error instanceof HNError && error.code === 'hn_comment_snapshot_invalid',
  )
})
