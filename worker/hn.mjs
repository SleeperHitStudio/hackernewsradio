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
    // The thing the thread is ABOUT. Link posts carry it here and leave `text`
    // empty, so dropping it left the writer with a headline and a pile of
    // reactions to an article it had never seen — which is exactly how episodes
    // ended up opening cold into the comments.
    articleUrl: typeof root.url === 'string' && /^https?:\/\//i.test(root.url) ? root.url : null,
    storyText: htmlToText(root.text || ''),
    author: root.author || 'unknown',
    points: root.points ?? null,
    comments,
    total: comments.length,
  }
}

/** Strip the page furniture that surrounds an article's actual prose. */
const ARTICLE_STRIP = [
  [/<script\b[\s\S]*?<\/script>/gi, ' '],
  [/<style\b[\s\S]*?<\/style>/gi, ' '],
  [/<(nav|header|footer|aside|form|svg|noscript)\b[\s\S]*?<\/\1>/gi, ' '],
  [/<!--[\s\S]*?-->/g, ' '],
]

/**
 * Fetch the linked article so the hosts can establish the SUBJECT before they
 * touch a single comment.
 *
 * Deliberately best-effort: paywalls, JS-only pages, hotlink blocks and dead
 * domains are all normal here. Every failure returns null rather than throwing,
 * because a missing article must degrade an episode's depth, never cost it the
 * episode — the thread alone still makes a show.
 */
export async function fetchArticle(url, { timeoutMs = 12_000, maxChars = 12_000 } = {}) {
  if (!url || !/^https?:\/\//i.test(url)) return null
  let res
  try {
    res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        // Some publishers 403 an unidentified agent outright.
        'User-Agent': 'Mozilla/5.0 (compatible; HNRadioBot/1.0; +https://hnradio.net)',
        Accept: 'text/html,application/xhtml+xml',
      },
    })
  } catch {
    return null
  }
  if (!res.ok) return null
  const type = res.headers.get('content-type') || ''
  // PDFs, video and images are not readable prose; do not pretend otherwise.
  if (!/text\/html|text\/plain|application\/xhtml/i.test(type)) return null

  let html
  try { html = await res.text() } catch { return null }

  let text = html
  for (const [re, sub] of ARTICLE_STRIP) text = text.replace(re, sub)
  text = htmlToText(text).replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()

  // Too little text means a paywall stub, a cookie wall, or a JS-only shell.
  // Half an article is worse than none: it invites confident wrong summaries.
  if (text.length < 400) return null

  const truncated = text.length > maxChars
  return {
    url,
    text: truncated ? `${text.slice(0, maxChars)}\n\n[HNR ARTICLE TRUNCATED]` : text,
    truncated,
  }
}

/**
 * Select comments across top-level branches rather than taking one depth-first
 * prefix. For ordinary threads the cap includes every comment; on huge threads
 * round-robin sampling preserves the breadth of the debate.
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

/**
 * The transcript's comment section is sized by TOTAL characters, not by a
 * comment count.
 *
 * A flat cap of 240 comments dropped 14% of episodes' threads, and the loss
 * landed hardest exactly where it hurt most: the 1057-comment GPT-5.6 thread
 * reached the writer as 240 comments, so it wrote an episode about a
 * discussion it had seen a fifth of. Meanwhile the per-comment cap was nearly
 * inert — the median HN comment is ~160 characters and under 1% run past 1600
 * — so the count was throwing away breadth to protect a budget that length was
 * never actually spending.
 *
 * Budgeting by characters inverts that. Ordinary threads arrive complete and
 * untouched; only a genuinely enormous one tightens per-comment excerpts, and
 * every commenter still appears. 360k characters is roughly 90k tokens, which
 * holds every thread this show has covered at full length.
 */
export const TRANSCRIPT_COMMENT_BUDGET = 360_000
export const TRANSCRIPT_MAX_CHARS_EACH = 1600
/**
 * Below this an excerpt stops being a quote and becomes a fragment the hosts
 * cannot honestly read aloud, so a thread big enough to need it loses comments
 * instead — the one case where dropping beats mangling.
 */
export const TRANSCRIPT_MIN_CHARS_EACH = 260

/** Total characters a set of comments costs when each is capped at `charsEach`. */
function budgetCost(comments, charsEach) {
  let total = 0
  for (const comment of comments) total += Math.min(comment.text.length, charsEach)
  return total
}

/**
 * Fit every comment into the budget, tightening excerpts only as far as needed.
 *
 * @returns {{ comments: Array, charsEach: number, complete: boolean }}
 */
export function planCommentBudget(comments, {
  budget = TRANSCRIPT_COMMENT_BUDGET,
  maxCharsEach = TRANSCRIPT_MAX_CHARS_EACH,
  minCharsEach = TRANSCRIPT_MIN_CHARS_EACH,
} = {}) {
  if (comments.length === 0) return { comments, charsEach: maxCharsEach, complete: true }

  // The common case: everything fits at full length, so nothing is touched.
  if (budgetCost(comments, maxCharsEach) <= budget) {
    return { comments, charsEach: maxCharsEach, complete: true }
  }

  // Largest per-comment allowance that still fits the whole thread. Binary
  // search rather than a divide, because cost is capped per comment — short
  // comments do not grow to fill the allowance, so cost is sublinear in it.
  let low = minCharsEach
  let high = maxCharsEach
  let best = null
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    if (budgetCost(comments, mid) <= budget) {
      best = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  if (best !== null) return { comments, charsEach: best, complete: true }

  // Even the floor does not fit. Keep breadth over depth: sample across
  // top-level branches so the debate's shape survives, and say so in the
  // transcript rather than letting the writer assume it saw everything.
  const perComment = minCharsEach
  const affordable = Math.max(1, Math.floor(budget / perComment))
  return {
    comments: selectAcrossBranches(comments, affordable),
    charsEach: perComment,
    complete: false,
  }
}

function excerpt(text, maxChars) {
  if (text.length <= maxChars) return text
  const prefix = text.slice(0, maxChars)
  const sentenceEnd = Math.max(prefix.lastIndexOf('. '), prefix.lastIndexOf('? '), prefix.lastIndexOf('! '))
  const wordEnd = prefix.lastIndexOf(' ')
  const end = sentenceEnd >= maxChars * 0.6 ? sentenceEnd + 1 : wordEnd
  return `${prefix.slice(0, Math.max(1, end)).trim()} [HNR EXCERPT SHORTENED]`
}

/** Render a complete, reply-aware transcript for the Story API. */
export function threadToTranscript(thread, budgetOptions = {}) {
  const plan = planCommentBudget(thread.comments, budgetOptions)
  const comments = plan.comments
  const lines = []
  lines.push(`# Hacker News thread: ${thread.title}`)
  lines.push(`Original link: ${thread.url} · posted by ${thread.author}` +
    (thread.points != null ? ` · ${thread.points} points` : ''))
  if (thread.articleUrl) lines.push(`Source article: ${thread.articleUrl}`)
  lines.push('')
  // The subject comes FIRST, before a single comment, because that is the order
  // the episode has to establish it in. A reader who meets the reactions before
  // the thing being reacted to writes an episode that never explains itself.
  if (thread.article?.text) {
    lines.push(`## THE SOURCE — what this thread is actually about`)
    lines.push(`Fetched from ${thread.article.url}. This is the SUBJECT of the episode. The`)
    lines.push('hosts must understand and explain it BEFORE they react to anyone in the comments:')
    lines.push('what was announced or claimed, who did it, what is genuinely new, and why this')
    lines.push('thread exists at all. Quote or paraphrase it accurately — it is reporting, not opinion.')
    lines.push('')
    lines.push(thread.article.text)
    lines.push('')
  } else if (thread.articleUrl) {
    // Say so explicitly. Silence here reads as "there was no article", and the
    // writer confidently invents one from the headline.
    lines.push(`## THE SOURCE — could not be retrieved`)
    lines.push(`The thread links to ${thread.articleUrl}, but its text could not be fetched`)
    lines.push('(paywall, bot block, or a JS-only page). Establish the subject from the HEADLINE and')
    lines.push('from what the commenters reveal about it. Do NOT invent specifics — no fabricated')
    lines.push('quotes, numbers, features, or claims attributed to the article.')
    lines.push('')
  }
  if (thread.storyText) {
    lines.push(`## Original post (by ${thread.author})`)
    lines.push(thread.storyText.slice(0, 1500))
    lines.push('')
  }
  lines.push(plan.complete
    ? `## Comments (all ${thread.total} of them — this is the ENTIRE thread)`
    : `## Comments (${thread.total} total; ${comments.length} included across top-level reply branches)`)
  lines.push('Source note: comments are complete unless explicitly marked [HNR EXCERPT SHORTENED]. Never claim an unmarked comment was cut off.')
  if (!plan.complete) {
    // Only say this when it is true. Telling the writer it saw a sample of a
    // thread it actually saw in full invites hedging about what it "might have
    // missed" in an episode that missed nothing.
    lines.push('This thread is large enough that it was sampled across top-level branches; you are seeing the breadth of the debate, not every reply.')
  }
  lines.push('')
  for (const c of comments) {
    const indent = '  '.repeat(Math.min(c.depth, 6))
    const reply = c.parentId ? ` reply_to=${c.parentId}` : ''
    const body = excerpt(c.text, plan.charsEach)
    lines.push(`${indent}- [comment=${c.id}${reply}] ${c.author}: ${body.replace(/\n+/g, ' ')}`)
  }
  return lines.join('\n')
}
