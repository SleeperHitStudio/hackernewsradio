import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'

/**
 * HNR's source contract is deliberately fail-closed:
 *
 * - Hacker News metadata/counts come from the official Firebase API.
 * - Comment bodies come from Algolia's paginated story-comment search.
 * - A thread is returned only when both services agree on the exact count.
 * - Linked articles are fully consumed and reader-extracted without clipping.
 *
 * A source that cannot be proved complete is not eligible for generation. That
 * is the only honest way to make every *generated* episode fully grounded.
 */

export const HN_FIREBASE_BASE = 'https://hacker-news.firebaseio.com/v0'
export const HN_ALGOLIA_BASE = 'https://hn.algolia.com/api/v1'
export const HN_FETCH_TIMEOUT_MS = 20_000
export const ARTICLE_FETCH_TIMEOUT_MS = 20_000
export const ARTICLE_FETCH_MAX_BYTES = 5_000_000
export const ARTICLE_MIN_CHARS = 400
export const ARTICLE_BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

// Sleeper Hit retains at most 1.5M characters for full-source grounding and
// accepts at most 4MB for inline text. HNR must reject above either boundary;
// letting the platform clamp would silently violate this module's guarantee.
export const STORY_SOURCE_MAX_CHARS = 1_500_000
export const STORY_SOURCE_MAX_BYTES = 4_000_000

export class HNError extends Error {
  constructor(message, { code = 'hn_source_error', details = null, cause } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'HNError'
    this.code = code
    this.details = details
  }
}

/** Pull the numeric item id out of any HN URL (or a bare id). */
export function parseItemId(input) {
  const raw = String(input ?? '').trim()
  if (/^\d+$/.test(raw)) return raw
  let url
  try { url = new URL(raw) } catch { throw new HNError(`Not a valid Hacker News URL: ${raw}`, { code: 'hn_url_invalid' }) }
  const host = url.hostname.replace(/^www\./, '')
  if (host !== 'news.ycombinator.com' && host !== 'hn.algolia.com') {
    throw new HNError(`Expected a news.ycombinator.com link, got ${host}`, { code: 'hn_url_invalid' })
  }
  const id = url.searchParams.get('id')
  if (!id || !/^\d+$/.test(id)) {
    throw new HNError(`No item id in URL: ${raw}`, { code: 'hn_url_invalid' })
  }
  return id
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function abortSignal(timeoutMs) {
  return typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined
}

async function fetchJson(url, {
  fetchImpl = fetch,
  timeoutMs = HN_FETCH_TIMEOUT_MS,
  label = 'Hacker News',
} = {}) {
  let response
  try {
    response = await fetchImpl(url, {
      signal: abortSignal(timeoutMs),
      headers: { Accept: 'application/json' },
    })
  } catch (error) {
    throw new HNError(`${label} could not be reached: ${error?.message || error}`, {
      code: 'hn_upstream_unavailable',
      cause: error,
    })
  }
  if (!response?.ok) {
    throw new HNError(`${label} returned ${response?.status ?? 'an unreadable response'} for ${url}`, {
      code: 'hn_upstream_error',
      details: { status: response?.status ?? null, url: String(url) },
    })
  }
  try {
    return await response.json()
  } catch (error) {
    throw new HNError(`${label} returned invalid JSON for ${url}`, {
      code: 'hn_upstream_invalid',
      cause: error,
    })
  }
}

function normalizeText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** HN comment bodies are HTML — decode them without losing link labels. */
export function htmlToText(html) {
  if (!html) return ''
  const { document } = parseHTML(`<html><body>${String(html)}</body></html>`)
  for (const element of document.querySelectorAll('script,style')) element.remove()
  for (const br of document.querySelectorAll('br')) br.replaceWith(document.createTextNode('\n'))
  for (const anchor of document.querySelectorAll('a[href]')) {
    const label = normalizeText(anchor.textContent)
    const href = anchor.getAttribute('href') || ''
    const rendered = label && label !== href ? `${label} (${href})` : (label || href)
    anchor.replaceWith(document.createTextNode(rendered))
  }
  for (const block of document.querySelectorAll('p,div,li,pre,blockquote')) {
    block.append(document.createTextNode('\n'))
  }
  return normalizeText(document.body?.textContent || '')
}

async function resolveStoryItem(inputId, options) {
  let id = String(inputId)
  const seen = new Set()
  for (let depth = 0; depth < 64; depth++) {
    if (seen.has(id)) {
      throw new HNError(`Hacker News parent chain for item ${inputId} contains a cycle.`, {
        code: 'hn_item_invalid',
      })
    }
    seen.add(id)
    const item = await fetchJson(`${HN_FIREBASE_BASE}/item/${id}.json`, {
      ...options,
      label: 'Official Hacker News API',
    })
    if (!item || typeof item !== 'object') {
      throw new HNError(`Hacker News item ${id} does not exist.`, { code: 'hn_item_missing' })
    }
    if (item.type === 'story') return item
    if (item.parent == null) {
      throw new HNError(`Hacker News item ${id} is not a story and has no parent story.`, {
        code: 'hn_item_invalid',
      })
    }
    id = String(item.parent)
  }
  throw new HNError(`Hacker News parent chain for item ${inputId} is too deep.`, {
    code: 'hn_item_invalid',
  })
}

function collectNestedStructure(root) {
  const parentById = new Map()
  const siblingRank = new Map()
  const commentsById = new Map()
  const visited = new Set()
  const visit = (node, parentId) => {
    for (const [index, child] of (node?.children ?? []).entries()) {
      const id = String(child.id)
      const traversalParentId = String(parentId)
      const declaredParentId = child?.parent_id == null ? traversalParentId : String(child.parent_id)
      if (!/^\d+$/.test(id)
        || !/^\d+$/.test(declaredParentId)
        || declaredParentId !== traversalParentId
        || visited.has(id)) {
        throw new HNError('HN Algolia returned an invalid recursive comment tree.', {
          code: 'hn_comment_snapshot_invalid',
          details: { id: id || null, parentId: declaredParentId || null },
        })
      }
      visited.add(id)
      parentById.set(id, traversalParentId)
      siblingRank.set(`${parentId}:${id}`, index)
      commentsById.set(id, {
        id,
        parentId: traversalParentId,
        author: typeof child?.author === 'string' ? child.author.trim() : '',
        text: htmlToText(child?.text ?? child?.comment_text ?? ''),
        createdAt: Number(child?.created_at_i ?? 0),
      })
      visit(child, id)
    }
  }
  visit(root, String(root.id))
  return { parentById, siblingRank, commentsById }
}

async function fetchAlgoliaCommentSnapshot(storyId, options) {
  const nestedUrl = `${HN_ALGOLIA_BASE}/items/${storyId}`
  const searchUrl = new URL(`${HN_ALGOLIA_BASE}/search_by_date`)
  searchUrl.searchParams.set('tags', `comment,story_${storyId}`)
  searchUrl.searchParams.set('hitsPerPage', '1000')
  searchUrl.searchParams.set('page', '0')

  const [nested, firstPage] = await Promise.all([
    fetchJson(nestedUrl, { ...options, label: 'HN Algolia item API' }),
    fetchJson(searchUrl, { ...options, label: 'HN Algolia comment API' }),
  ])

  const nbHits = Number(firstPage?.nbHits)
  const nbPages = Number(firstPage?.nbPages)
  if (!Number.isInteger(nbHits) || nbHits < 0 || !Number.isInteger(nbPages) || nbPages < 0) {
    throw new HNError(`HN Algolia returned invalid pagination for story ${storyId}.`, {
      code: 'hn_comment_snapshot_invalid',
    })
  }

  // Algolia's index reports the true nbHits but caps ordinary page traversal
  // at 1,000 results. Walk the date-sorted index with an inclusive timestamp
  // cursor instead. Boundary duplicates are expected and de-duplicated; the
  // recursive item tree below fills any just-indexed edge that one view lacks.
  const hitsById = new Map()
  let page = firstPage
  let cursorUpperBound = null
  for (let batch = 0; batch < 64; batch++) {
    const pageHits = Array.isArray(page?.hits) ? page.hits : []
    const pageIds = new Set()
    for (const hit of pageHits) {
      const id = String(hit?.objectID ?? hit?.id ?? '')
      if (!/^\d+$/.test(id) || pageIds.has(id)) {
        throw new HNError(`HN Algolia returned duplicate or invalid search hits for story ${storyId}.`, {
          code: 'hn_comment_snapshot_invalid',
        })
      }
      pageIds.add(id)
      if (!hitsById.has(id)) hitsById.set(id, hit)
    }
    if (hitsById.size >= nbHits || pageHits.length === 0) break

    const timestamps = pageHits.map((hit) => Number(hit?.created_at_i))
    if (timestamps.some((value) => !Number.isInteger(value) || value < 0)) {
      throw new HNError(`HN Algolia returned an invalid comment timestamp for story ${storyId}.`, {
        code: 'hn_comment_snapshot_invalid',
      })
    }
    const oldest = Math.min(...timestamps)
    if (cursorUpperBound !== null && oldest >= cursorUpperBound) break
    cursorUpperBound = oldest
    const cursorUrl = new URL(searchUrl)
    cursorUrl.searchParams.set('numericFilters', `created_at_i<=${oldest}`)
    page = await fetchJson(cursorUrl, { ...options, label: 'HN Algolia comment API' })
  }

  const hits = [...hitsById.values()]
  if (String(nested?.id ?? '') !== String(storyId)) {
    throw new HNError(`HN Algolia returned the wrong recursive item for story ${storyId}.`, {
      code: 'hn_comment_snapshot_invalid',
    })
  }
  return { nested, hits, nbHits }
}

function orderedComments(storyId, hits, nested) {
  const searchCommentsById = new Map()
  for (const hit of hits) {
    const id = String(hit?.objectID ?? hit?.id ?? '')
    const parentId = String(hit?.parent_id ?? '')
    const hitStoryId = String(hit?.story_id ?? '')
    const text = htmlToText(hit?.comment_text ?? hit?.text ?? '')
    if (!/^\d+$/.test(id) || !/^\d+$/.test(parentId) || hitStoryId !== String(storyId)) {
      throw new HNError(`HN Algolia returned an incomplete comment in story ${storyId}.`, {
        code: 'hn_comment_snapshot_invalid',
        details: { id: id || null, parentId: parentId || null, storyId: hitStoryId || null },
      })
    }
    if (searchCommentsById.has(id)) {
      throw new HNError(`HN Algolia returned duplicate comment ${id} in story ${storyId}.`, {
        code: 'hn_comment_snapshot_invalid',
      })
    }
    searchCommentsById.set(id, {
      id,
      parentId,
      author: typeof hit?.author === 'string' ? hit.author.trim() : '',
      text,
      createdAt: Number(hit.created_at_i ?? 0),
    })
  }

  const {
    parentById: structuralParents,
    siblingRank,
    commentsById: nestedCommentsById,
  } = collectNestedStructure(nested)
  const commentsById = new Map()
  const allSnapshotIds = new Set([...nestedCommentsById.keys(), ...searchCommentsById.keys()])
  for (const id of allSnapshotIds) {
    const searched = searchCommentsById.get(id)
    const nestedComment = nestedCommentsById.get(id)
    if (searched && nestedComment && searched.parentId !== nestedComment.parentId) {
      throw new HNError(`HN Algolia returned conflicting parents for comment ${id} in story ${storyId}.`, {
        code: 'hn_comment_snapshot_changed',
      })
    }
    const text = searched?.text || nestedComment?.text || ''
    const parentId = searched?.parentId || nestedComment?.parentId || ''
    const author = searched?.author || nestedComment?.author || ''
    if (!text || !author || !/^\d+$/.test(parentId)) {
      throw new HNError(`HN Algolia returned an incomplete comment in story ${storyId}.`, {
        code: 'hn_comment_snapshot_invalid',
        details: { id, parentId: parentId || null },
      })
    }
    commentsById.set(id, {
      id,
      parentId,
      author,
      text,
      createdAt: searched?.createdAt || nestedComment?.createdAt || 0,
    })
  }

  const childIds = new Map()
  const allIds = new Set([...structuralParents.keys(), ...commentsById.keys()])

  for (const id of allIds) {
    const parentId = commentsById.get(id)?.parentId || structuralParents.get(id)
    if (!parentId) continue
    if (!childIds.has(parentId)) childIds.set(parentId, [])
    if (!childIds.get(parentId).includes(id)) childIds.get(parentId).push(id)
  }

  const compareSiblings = (parentId, left, right) => {
    const leftRank = siblingRank.get(`${parentId}:${left}`)
    const rightRank = siblingRank.get(`${parentId}:${right}`)
    if (leftRank !== undefined || rightRank !== undefined) {
      return (leftRank ?? Number.MAX_SAFE_INTEGER) - (rightRank ?? Number.MAX_SAFE_INTEGER)
    }
    const leftTime = commentsById.get(left)?.createdAt ?? 0
    const rightTime = commentsById.get(right)?.createdAt ?? 0
    return leftTime - rightTime || Number(left) - Number(right)
  }
  for (const [parentId, ids] of childIds) ids.sort((a, b) => compareSiblings(parentId, a, b))

  const result = []
  const visitedNodes = new Set()
  const visitedComments = new Set()
  const visit = (parentId, depth, branch) => {
    for (const id of childIds.get(String(parentId)) ?? []) {
      if (visitedNodes.has(id)) continue
      visitedNodes.add(id)
      const comment = commentsById.get(id)
      const nextBranch = branch ?? id
      if (comment) {
        result.push({
          id,
          parentId: comment.parentId === String(storyId) ? null : comment.parentId,
          branch: nextBranch,
          author: comment.author,
          depth,
          text: comment.text,
        })
        visitedComments.add(id)
      }
      // Deleted/dead structural placeholders remain traversable so replies to
      // them are not orphaned or dropped.
      visit(id, depth + 1, nextBranch)
    }
  }
  visit(String(storyId), 0, null)

  // A just-indexed Algolia comment can precede the nested-item cache. Preserve
  // it rather than losing content; count agreement remains the completeness
  // proof and these orphans are rendered last with their real parent id.
  const unvisited = [...commentsById.values()]
    .filter((comment) => !visitedComments.has(comment.id))
    .sort((a, b) => a.createdAt - b.createdAt || Number(a.id) - Number(b.id))
  for (const comment of unvisited) {
    let depth = 0
    let cursor = comment.parentId
    const seen = new Set([comment.id])
    while (cursor !== String(storyId) && !seen.has(cursor) && depth < 64) {
      seen.add(cursor)
      depth++
      cursor = commentsById.get(cursor)?.parentId || structuralParents.get(cursor) || String(storyId)
    }
    result.push({
      id: comment.id,
      parentId: comment.parentId === String(storyId) ? null : comment.parentId,
      branch: comment.id,
      author: comment.author,
      depth,
      text: comment.text,
    })
  }

  return result
}

/**
 * How far Algolia's index may trail Hacker News' own `descendants` count before
 * a capture is refused.
 *
 * The two sources are eventually consistent by nature: `descendants` is a live
 * counter on an active thread, and the search index catches up seconds to
 * minutes later. Requiring exact equality therefore fails hardest on the
 * busiest threads — the ones the show most wants — and it failed on a
 * one-comment gap twice in two nights (117 vs 116, 90 vs 89). Both threads
 * later converged exactly, so the gap is lag, not loss.
 *
 * Ten percent keeps a genuinely partial capture out of the show while letting
 * ordinary index lag through. What we actually captured is recorded honestly on
 * `completeness.comments` rather than being rounded up to "complete".
 */
export const HN_COMMENT_COVERAGE_TOLERANCE = 0.1

/** The fewest comments a capture may hold and still count as usable. */
export function hnCommentCoverageFloor(expected) {
  const target = Number(expected)
  if (!Number.isFinite(target) || target <= 0) return 0
  return Math.ceil(target * (1 - HN_COMMENT_COVERAGE_TOLERANCE))
}

/**
 * Fetch one complete, count-verified HN thread. A comment URL is resolved all
 * the way to its story before the snapshot is taken.
 */
export async function fetchThread(input, {
  fetchImpl = fetch,
  timeoutMs = HN_FETCH_TIMEOUT_MS,
  maxAttempts = 3,
  retryDelaysMs = [1_500, 4_000],
} = {}) {
  const inputId = parseItemId(input)
  const options = { fetchImpl, timeoutMs }
  const initialStory = await resolveStoryItem(inputId, options)
  const storyId = String(initialStory.id)
  let lastError = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const [root, snapshot] = await Promise.all([
        fetchJson(`${HN_FIREBASE_BASE}/item/${storyId}.json`, {
          ...options,
          label: 'Official Hacker News API',
        }),
        fetchAlgoliaCommentSnapshot(storyId, options),
      ])
      if (root?.type !== 'story' || String(root.id) !== storyId) {
        throw new HNError(`Official Hacker News item ${storyId} is no longer a story.`, {
          code: 'hn_item_invalid',
        })
      }

      const expected = Number(root.descendants ?? 0)
      if (!Number.isInteger(expected) || expected < 0) {
        throw new HNError(`Official Hacker News returned an invalid comment count for ${storyId}.`, {
          code: 'hn_comment_snapshot_invalid',
        })
      }
      const comments = orderedComments(storyId, snapshot.hits, snapshot.nested)
      // Only a SHORTFALL is a problem. An index that reports more comments than
      // `descendants` is simply fresher than the counter we read a moment ago,
      // which is a newer thread, never an incomplete one.
      const floor = hnCommentCoverageFloor(expected)
      if (snapshot.nbHits < floor || comments.length < floor) {
        throw new HNError(
          `Hacker News thread ${storyId} is not synchronized yet: official count ${expected}, `
          + `Algolia count ${snapshot.nbHits}, decoded ${comments.length}, `
          + `need at least ${floor}.`,
          {
            code: 'hn_thread_incomplete',
            details: {
              storyId, expected, algolia: snapshot.nbHits, decoded: comments.length, floor, attempt,
            },
          },
        )
      }

      const capturedAt = new Date().toISOString()
      return {
        id: storyId,
        title: htmlToText(root.title || '') || `Hacker News discussion #${storyId}`,
        url: `https://news.ycombinator.com/item?id=${storyId}`,
        articleUrl: typeof root.url === 'string' && /^https?:\/\//i.test(root.url) ? root.url : null,
        storyText: htmlToText(root.text || ''),
        author: root.by || 'unknown',
        points: root.score ?? null,
        comments,
        total: comments.length,
        completeness: {
          comments: {
            // `complete` stays literal: it means we hold every comment HN
            // counted. Within tolerance but short is usable, not complete, and
            // the show says so rather than claiming a full thread.
            complete: comments.length >= expected,
            expected,
            fetched: comments.length,
            capturedAt,
            metadataSource: 'official-hn-firebase',
            contentSource: 'hn-algolia-search-plus-recursive-item-tree',
          },
        },
      }
    } catch (error) {
      lastError = error
      if (attempt < maxAttempts) {
        await delay(retryDelaysMs[Math.min(attempt - 1, retryDelaysMs.length - 1)] ?? 0)
      }
    }
  }

  if (lastError instanceof HNError) throw lastError
  throw new HNError(`Could not capture a complete Hacker News thread ${storyId}.`, {
    code: 'hn_thread_incomplete',
    cause: lastError,
  })
}

function contentTypeOf(response) {
  return String(response.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase()
}

function charsetOf(response) {
  const value = String(response.headers?.get?.('content-type') || '')
  return value.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1] || 'utf-8'
}

async function readCompleteBody(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HNError(`Source article is ${declared} bytes, above HNR's ${maxBytes}-byte completeness limit.`, {
      code: 'article_too_large',
      details: { declaredBytes: declared, maxBytes },
    })
  }
  let bytes
  try {
    bytes = new Uint8Array(await response.arrayBuffer())
  } catch (error) {
    throw new HNError(`Source article body ended before it could be read completely: ${error?.message || error}`, {
      code: 'article_body_incomplete',
      cause: error,
    })
  }
  if (bytes.byteLength > maxBytes) {
    throw new HNError(`Source article is ${bytes.byteLength} bytes, above HNR's ${maxBytes}-byte completeness limit.`, {
      code: 'article_too_large',
      details: { observedBytes: bytes.byteLength, maxBytes },
    })
  }
  return bytes
}

function decodeBytes(bytes, charset) {
  try { return new TextDecoder(charset, { fatal: false }).decode(bytes) } catch {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  }
}

const PAYWALL_MARKERS = [
  /subscribe(?: now)? to (?:continue|keep) reading/i,
  /sign in(?: or subscribe)? to continue reading/i,
  /(?:this|the full) (?:article|story) is (?:available )?(?:only )?to subscribers/i,
  /you(?:'ve| have) reached your (?:free )?(?:article )?limit/i,
  /register(?: now)? to (?:continue|keep) reading/i,
  /continue reading (?:with|by subscribing)/i,
]

function structuredArticleData(document) {
  const bodies = []
  let accessRestricted = false
  let headline = null
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (!value || typeof value !== 'object') return
    const type = Array.isArray(value['@type']) ? value['@type'] : [value['@type']]
    const articleLike = type.some((entry) => /(?:article|blogposting|report)$/i.test(String(entry || '')))
      || typeof value.articleBody === 'string'
    if (articleLike) {
      if (value.isAccessibleForFree === false || value.isAccessibleForFree === 'false') accessRestricted = true
      if (typeof value.articleBody === 'string') {
        const body = normalizeText(value.articleBody)
        if (body) bodies.push(body)
      }
      if (!headline && typeof value.headline === 'string') headline = normalizeText(value.headline)
    }
    for (const child of Object.values(value)) visit(child)
  }

  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try { visit(JSON.parse(script.textContent || 'null')) } catch { /* malformed metadata is non-authoritative */ }
  }
  return {
    accessRestricted,
    headline,
    body: bodies.sort((left, right) => right.length - left.length)[0] || '',
  }
}

function assertNotPartialArticle(text, { accessRestricted = false, url } = {}) {
  if (accessRestricted || PAYWALL_MARKERS.some((pattern) => pattern.test(text))) {
    throw new HNError(`Source article at ${url} is paywalled or only exposed as a reading preview.`, {
      code: 'article_paywalled',
      details: { url },
    })
  }
}

function extractReadableArticle(html, finalUrl) {
  const { document } = parseHTML(html)
  const base = document.createElement('base')
  base.setAttribute('href', finalUrl)
  if (document.head) document.head.prepend(base)
  const structured = structuredArticleData(document)
  const parsed = new Readability(document, { charThreshold: ARTICLE_MIN_CHARS }).parse()
  const readableText = normalizeText(parsed?.textContent || '')
  const text = structured.body.length > readableText.length ? structured.body : readableText
  if (text.length < ARTICLE_MIN_CHARS) return null
  assertNotPartialArticle(text, { accessRestricted: structured.accessRestricted, url: finalUrl })
  return {
    title: normalizeText(parsed?.title || structured.headline || '') || null,
    byline: normalizeText(parsed?.byline || '') || null,
    publishedTime: parsed?.publishedTime || null,
    text,
  }
}

/**
 * Fetch and reader-extract the entire linked article. There is no character
 * truncation path. Unsupported, blocked, partial, or unreadable sources throw,
 * making the story ineligible instead of generating from a headline.
 */
export async function fetchArticle(url, {
  fetchImpl = fetch,
  timeoutMs = ARTICLE_FETCH_TIMEOUT_MS,
  maxBytes = ARTICLE_FETCH_MAX_BYTES,
} = {}) {
  if (!url || !/^https?:\/\//i.test(url)) {
    throw new HNError(`Source article URL is invalid: ${String(url ?? '')}`, { code: 'article_url_invalid' })
  }

  let response
  try {
    response = await fetchImpl(url, {
      redirect: 'follow',
      signal: abortSignal(timeoutMs),
      headers: {
        // Several first-party article sites return a bot interstitial or 403 to
        // the old HNRadioBot token while serving the same public document to a
        // normal browser request. Use stable browser negotiation headers, then
        // apply the exact same byte/readability/paywall completeness checks.
        'User-Agent': ARTICLE_BROWSER_USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,text/plain,text/markdown;q=0.9',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    })
  } catch (error) {
    throw new HNError(`Source article could not be reached: ${error?.message || error}`, {
      code: 'article_unavailable',
      cause: error,
    })
  }
  if (!response?.ok) {
    throw new HNError(`Source article returned HTTP ${response?.status ?? 'unknown'} for ${url}.`, {
      code: 'article_unavailable',
      details: { status: response?.status ?? null, url },
    })
  }
  if (response.status === 206 || response.headers?.get?.('content-range')) {
    throw new HNError(`Source article returned only a partial HTTP body for ${url}.`, {
      code: 'article_body_incomplete',
      details: { status: response.status, contentRange: response.headers?.get?.('content-range') || null },
    })
  }

  const contentType = contentTypeOf(response)
  const supported = new Set([
    'text/html',
    'application/xhtml+xml',
    'text/plain',
    'text/markdown',
    'text/x-markdown',
  ])
  if (!supported.has(contentType)) {
    throw new HNError(`Source article type ${contentType || '(missing)'} cannot be read completely by HNR.`, {
      code: 'article_type_unsupported',
      details: { contentType: contentType || null, url },
    })
  }

  const bytes = await readCompleteBody(response, maxBytes)
  const decoded = decodeBytes(bytes, charsetOf(response))
  const finalUrl = response.url || url
  let extracted
  if (contentType === 'text/html' || contentType === 'application/xhtml+xml') {
    extracted = extractReadableArticle(decoded, finalUrl)
  } else {
    const text = normalizeText(decoded)
    assertNotPartialArticle(text, { url: finalUrl })
    extracted = text.length >= ARTICLE_MIN_CHARS
      ? { title: null, byline: null, publishedTime: null, text }
      : null
  }
  if (!extracted) {
    throw new HNError(`Source article at ${finalUrl} did not yield a complete readable body.`, {
      code: 'article_unreadable',
      details: { contentType, rawBytes: bytes.byteLength },
    })
  }

  return {
    url: finalUrl,
    requestedUrl: url,
    contentType,
    rawByteSize: bytes.byteLength,
    title: extracted.title,
    byline: extracted.byline,
    publishedTime: extracted.publishedTime,
    text: extracted.text,
    charCount: extracted.text.length,
    complete: true,
    truncated: false,
    fetchedAt: new Date().toISOString(),
  }
}

/** Attach the linked article (when any) and prove the combined source is usable. */
export async function hydrateThreadArticle(thread, options = {}) {
  thread.article = thread?.articleUrl
    ? await fetchArticle(thread.articleUrl, options)
    : null
  assertCompleteThread(thread)
  return thread
}

export function assertCompleteThread(thread) {
  const comments = Array.isArray(thread?.comments) ? thread.comments : []
  const total = Number(thread?.total)
  const ids = new Set()
  if (!Number.isInteger(total) || total < 0 || comments.length !== total) {
    throw new HNError(
      `Thread completeness check failed: expected ${Number.isFinite(total) ? total : 'a valid count'} comments, received ${comments.length}.`,
      { code: 'hn_thread_incomplete' },
    )
  }
  for (const comment of comments) {
    const id = String(comment?.id ?? '')
    if (!id || ids.has(id) || !String(comment?.text ?? '').trim()) {
      throw new HNError(`Thread completeness check failed at comment ${id || '(missing id)'}.`, {
        code: 'hn_thread_incomplete',
      })
    }
    ids.add(id)
  }
  const proof = thread?.completeness?.comments
  // `fetched` must still match the captured array exactly — that is internal
  // consistency, and a mismatch means the proof was built against different
  // comments. `expected` is the live HN count, which the capture is allowed to
  // trail by the coverage tolerance.
  if (!proof || Number(proof.fetched) !== total || !Number.isFinite(Number(proof.expected))
    || total < hnCommentCoverageFloor(Number(proof.expected))) {
    throw new HNError('Thread completeness proof does not match the captured comments.', {
      code: 'hn_thread_incomplete',
    })
  }
  if (thread?.articleUrl) {
    const articleText = String(thread.article?.text ?? '')
    const articleChars = Number(thread.article?.charCount)
    if (!thread.article?.complete
      || thread.article?.truncated
      || !articleText.trim()
      || !Number.isInteger(articleChars)
      || articleChars !== articleText.length) {
      throw new HNError(`Linked article ${thread.articleUrl} is not complete; generation is not allowed.`, {
        code: 'article_incomplete',
      })
    }
  }
  return true
}

/** Render the complete article/self-post/thread source passed to Sleeper Hit. */
export function threadToTranscript(thread, {
  maxChars = STORY_SOURCE_MAX_CHARS,
  maxBytes = STORY_SOURCE_MAX_BYTES,
} = {}) {
  assertCompleteThread(thread)
  const comments = thread.comments
  const lines = []
  lines.push(`# Hacker News thread: ${thread.title}`)
  lines.push(`Original link: ${thread.url} · posted by ${thread.author}`
    + (thread.points != null ? ` · ${thread.points} points` : ''))
  if (thread.articleUrl) lines.push(`Source article: ${thread.article.url}`)
  lines.push('')
  lines.push('## SOURCE COMPLETENESS — VERIFIED')
  lines.push(`Comments: ${commentCoveragePhrase(thread)}, with full text and reply relationships.`)
  if (thread.completeness?.comments?.capturedAt) {
    lines.push(`Thread snapshot captured at ${thread.completeness.comments.capturedAt}.`)
  }
  if (thread.articleUrl) {
    lines.push(`Article: complete reader extraction, ${thread.article.charCount ?? thread.article.text.length} characters, no clipping.`)
  }
  lines.push('')

  if (thread.articleUrl) {
    lines.push('## THE COMPLETE SOURCE ARTICLE — what this thread is actually about')
    lines.push(`Fetched in full from ${thread.article.url}. This is the SUBJECT of the episode.`)
    lines.push('The hosts must understand and explain it BEFORE reacting to comments. Quote or paraphrase it accurately.')
    lines.push('')
    lines.push(`<<<HNR_ARTICLE_BEGIN chars=${thread.article.charCount ?? thread.article.text.length}>>>`)
    lines.push(thread.article.text)
    lines.push('<<<HNR_ARTICLE_END>>>')
    lines.push('')
  }
  if (thread.storyText) {
    lines.push(`## COMPLETE ORIGINAL POST (by ${thread.author})`)
    lines.push(`<<<HNR_SELF_POST_BEGIN chars=${thread.storyText.length}>>>`)
    lines.push(thread.storyText)
    lines.push('<<<HNR_SELF_POST_END>>>')
    lines.push('')
  }
  lines.push(`## COMPLETE COMMENT THREAD (all ${thread.total} comments)`)
  lines.push('Every visible comment in the verified snapshot follows. Preserve handles, quotes, reply context, minority positions, and late branches.')
  lines.push(`<<<HNR_COMMENTS_BEGIN count=${thread.total}>>>`)
  lines.push('')
  for (const comment of comments) {
    const indent = '  '.repeat(Math.min(comment.depth, 12))
    const reply = comment.parentId ? ` reply_to=${comment.parentId}` : ''
    const bodyLines = String(comment.text).split('\n')
    lines.push(`${indent}- [comment=${comment.id}${reply}] ${comment.author}: ${bodyLines.shift()}`)
    for (const bodyLine of bodyLines) lines.push(`${indent}  ${bodyLine}`)
  }
  lines.push('<<<HNR_COMMENTS_END>>>')

  const transcript = lines.join('\n')
  const byteSize = new TextEncoder().encode(transcript).byteLength
  if (transcript.length > maxChars || byteSize > maxBytes) {
    throw new HNError(
      `Verified source is too large to pass without clipping (${transcript.length} chars / ${byteSize} bytes; `
      + `limits ${maxChars} chars / ${maxBytes} bytes).`,
      {
        code: 'source_pack_too_large',
        details: { chars: transcript.length, bytes: byteSize, maxChars, maxBytes },
      },
    )
  }
  return transcript
}

/**
 * Metadata sent beside the text source. `sourceContextMode: full` is the
 * cross-service contract: Sleeper Hit must hash-check and pass this exact text
 * to both the planner and final table-read writer, never a digest or preview.
 */
export function buildSourceMetadata(thread, transcript) {
  assertCompleteThread(thread)
  const content = String(transcript ?? '')
  const byteSize = new TextEncoder().encode(content).byteLength
  if (!content || content.length > STORY_SOURCE_MAX_CHARS || byteSize > STORY_SOURCE_MAX_BYTES) {
    throw new HNError('Verified source metadata cannot be built for missing or oversized text.', {
      code: 'source_pack_too_large',
      details: {
        chars: content.length,
        bytes: byteSize,
        maxChars: STORY_SOURCE_MAX_CHARS,
        maxBytes: STORY_SOURCE_MAX_BYTES,
      },
    })
  }

  const commentProof = thread.completeness.comments
  return {
    sourceProducer: 'hackernewsradio',
    sourceContextMode: 'full',
    hnStoryId: String(thread.id),
    sourceCompleteness: {
      comments: {
        // Reported, not asserted. The platform stores this alongside the source
        // and it is the only durable record of how much of the thread the
        // episode was actually written against.
        complete: commentProof.complete === true,
        expected: Number(commentProof.expected),
        fetched: Number(commentProof.fetched),
        capturedAt: commentProof.capturedAt,
        metadataSource: commentProof.metadataSource,
        contentSource: commentProof.contentSource,
      },
      article: {
        required: Boolean(thread.articleUrl),
        complete: !thread.articleUrl || thread.article.complete === true,
        url: thread.articleUrl ? thread.article.url : null,
        chars: thread.articleUrl ? Number(thread.article.charCount ?? thread.article.text.length) : 0,
        rawBytes: thread.articleUrl ? Number(thread.article.rawByteSize ?? 0) : 0,
        fetchedAt: thread.articleUrl ? thread.article.fetchedAt : null,
      },
      post: {
        required: Boolean(thread.storyText),
        complete: true,
        chars: thread.storyText ? thread.storyText.length : 0,
      },
      sourcePack: {
        complete: true,
        chars: content.length,
        bytes: byteSize,
        clipped: false,
      },
    },
  }
}

/**
 * "116/116" when we hold the whole thread, "116/117 (index lag)" when the
 * capture is inside tolerance but short. The writer and the episode's progress
 * trail both read this, so it must never round a partial thread up to a
 * complete one.
 */
export function commentCoveragePhrase(thread) {
  const fetched = Number(thread?.total ?? 0)
  const expected = Number(thread?.completeness?.comments?.expected ?? fetched)
  if (!Number.isFinite(expected) || expected <= fetched) return `${fetched}/${fetched}`
  return `${fetched}/${expected} (index lag)`
}

export function verifiedSourceProgress(thread) {
  const article = thread.articleUrl
    ? ` and full article (${thread.article.charCount ?? thread.article.text.length} characters)`
    : thread.storyText
      ? ` and full self-post (${thread.storyText.length} characters)`
      : ' and no linked article or self-post'
  const complete = thread?.completeness?.comments?.complete === true
  const label = complete ? 'Verified complete source' : 'Verified source'
  return `${label}: ${commentCoveragePhrase(thread)} comments${article}`
}
