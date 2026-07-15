/**
 * Fetch a Hacker News thread and flatten it into a clean transcript the Story
 * API can digest. Uses the public Algolia HN API (no key, no rate-limit pain):
 *   https://hn.algolia.com/api/v1/items/<id>  →  nested comment tree.
 */

export class HNError extends Error {
  constructor(message) { super(message); this.name = 'HNError' }
}

/** Pull the numeric item id out of any HN URL (or a bare id). */
export function parseItemId(input) {
  const raw = String(input ?? '').trim()
  if (/^\d+$/.test(raw)) return raw
  let url
  try { url = new URL(raw) } catch { throw new HNError(`Not a valid Hacker News URL: ${raw}`) }
  const host = url.hostname.replace(/^www\./, '')
  if (host !== 'news.ycombinator.com' && host !== 'hn.algolia.com') {
    throw new HNError(`Expected a news.ycombinator.com link, got ${host}`)
  }
  const id = url.searchParams.get('id')
  if (!id || !/^\d+$/.test(id)) throw new HNError(`No item id in URL: ${raw}`)
  return id
}

const STRIP = [
  [/<\/p>/gi, '\n\n'], [/<p>/gi, ''],
  [/<a [^>]*href="([^"]*)"[^>]*>.*?<\/a>/gi, '$1'],
  [/<i>(.*?)<\/i>/gi, '$1'], [/<[^>]+>/g, ''],
]

/** HN comment bodies are HTML — decode to readable plain text. */
function htmlToText(html) {
  if (!html) return ''
  let t = html
  for (const [re, sub] of STRIP) t = t.replace(re, sub)
  t = t
    .replace(/&#x2F;/g, '/').replace(/&#x27;/g, "'").replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  return t.replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Flatten the comment tree depth-first into an ordered list. Each entry keeps
 * the author, depth (for "replying to" texture), and decoded text.
 */
function flatten(node, depth, out, branch = null, parentId = null) {
  for (const [index, child] of (node.children ?? []).entries()) {
    const childBranch = branch ?? index
    if (child.type === 'comment' && child.text && !child.deleted && !child.dead) {
      out.push({
        id: String(child.id),
        parentId: parentId == null ? null : String(parentId),
        branch: childBranch,
        author: child.author || 'someone',
        depth,
        text: htmlToText(child.text),
      })
    }
    flatten(child, depth + 1, out, childBranch, child.id)
  }
}

/**
 * @returns {{ id, title, url, storyText, author, points, comments: Array<{author,depth,text}>, total }}
 */
export async function fetchThread(input) {
  const id = parseItemId(input)
  let res
  try {
    res = await fetch(`https://hn.algolia.com/api/v1/items/${id}`, {
      headers: { Accept: 'application/json' },
    })
  } catch (err) {
    throw new HNError(`Could not reach Hacker News: ${err.message}`)
  }
  if (!res.ok) throw new HNError(`Hacker News returned ${res.status} for item ${id}`)
  const root = await res.json()

  // If the URL pointed at a comment rather than a story, climb to its story.
  const title = root.title || root.story_title || `Hacker News discussion #${id}`
  const comments = []
  flatten(root, 0, comments)

  return {
    id,
    title,
    url: `https://news.ycombinator.com/item?id=${id}`,
    storyText: htmlToText(root.text || ''),
    author: root.author || 'unknown',
    points: root.points ?? null,
    comments,
    total: comments.length,
  }
}

/**
 * Render the thread as a transcript for the Story API source. Caps the number
 * of comments and per-comment length so a huge thread doesn't blow the source
 * budget — the planner gets the title, the OP, and the densest slice of debate.
 */
function selectAcrossBranches(comments, maxComments) {
  if (comments.length <= maxComments) return comments
  const groups = new Map()
  for (const comment of comments) {
    const key = comment.branch ?? 0
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(comment)
  }
  const selected = []
  const queues = [...groups.values()]
  for (let index = 0; selected.length < maxComments; index++) {
    let added = false
    for (const queue of queues) {
      if (queue[index]) {
        selected.push(queue[index])
        added = true
        if (selected.length === maxComments) break
      }
    }
    if (!added) break
  }
  return selected
}

function excerpt(text, maxChars) {
  if (text.length <= maxChars) return text
  const prefix = text.slice(0, maxChars)
  const sentenceEnd = Math.max(prefix.lastIndexOf('. '), prefix.lastIndexOf('? '), prefix.lastIndexOf('! '))
  const wordEnd = prefix.lastIndexOf(' ')
  const end = sentenceEnd >= maxChars * 0.6 ? sentenceEnd + 1 : wordEnd
  return `${prefix.slice(0, Math.max(1, end)).trim()} [HNR EXCERPT SHORTENED]`
}

export function threadToTranscript(thread, { maxComments = 240, maxCharsEach = 1600 } = {}) {
  const comments = selectAcrossBranches(thread.comments, maxComments)
  const lines = []
  lines.push(`# Hacker News thread: ${thread.title}`)
  lines.push(`Original link: ${thread.url} · posted by ${thread.author}` +
    (thread.points != null ? ` · ${thread.points} points` : ''))
  lines.push('')
  if (thread.storyText) {
    lines.push(`## Original post (by ${thread.author})`)
    lines.push(thread.storyText.slice(0, 1500))
    lines.push('')
  }
  lines.push(`## Comments (${thread.total} total; ${comments.length} included across top-level reply branches)`)
  lines.push('Source note: comments are complete unless explicitly marked [HNR EXCERPT SHORTENED]. Never claim an unmarked comment was cut off.')
  lines.push('')
  for (const c of comments) {
    const indent = '  '.repeat(Math.min(c.depth, 6))
    const reply = c.parentId ? ` reply_to=${c.parentId}` : ''
    const body = excerpt(c.text, maxCharsEach)
    lines.push(`${indent}- [comment=${c.id}${reply}] ${c.author}: ${body.replace(/\n+/g, ' ')}`)
  }
  return lines.join('\n')
}
