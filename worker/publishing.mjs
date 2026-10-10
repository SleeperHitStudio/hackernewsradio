/**
 * The podcast feed side of HNR, shared by the pipeline and the nightly.
 *
 * HNR is an UNATTENDED producer. It publishes, and approves its plans, only
 * under the PublishingSeries' standing approval — a grant bound to HNR's API
 * key that the owner can revoke — and never by claiming a human
 * `userConfirmed` it did not get. See readiness.mjs for how the grant is read.
 */

/** Progress line recorded when an episode reaches the feed. */
export const PUBLISHED_PROGRESS_MESSAGE = 'Published to the HNR podcast feed.'

export const EPISODE_DESCRIPTION_DIRECTION = 'Write one pithy sentence, 20-40 words, that sells this specific episode. Be irreverent, playful, and sharp, but use no profanity. Lead with the transcript’s actual tension, argument, or absurdity. Avoid host roll calls, generic show boilerplate, and phrases like “the hosts discuss” or “this episode explores.” Commenters go by invented names in the episode: never write a username or handle, and never guess one.'

const HN_THREAD_URL_RE = /^https:\/\/news\.ycombinator\.com\/item\?id=\d+$/

/**
 * THE SHOW NOTES (owner, 2026-10-09): every episode's notes LINK the original Hacker News thread and the
 * article it discusses, and name nobody by username. The platform writes the one-sentence description
 * from the script (whose commenters already go by invented names); HNR appends the links, so the RSS
 * description and the episode page carry them whatever the sentence says. Applies to episodes
 * published from now on; a release already on the feed is never edited (publishEpisode returns it as is).
 */
export function composeShowNotes(description, { threadUrl, articleUrl = null } = {}) {
  const thread = String(threadUrl ?? '').trim()
  if (!HN_THREAD_URL_RE.test(thread)) {
    throw new Error(`Show notes need the Hacker News thread link (got ${thread || 'nothing'}).`)
  }
  let article = null
  try {
    const parsed = articleUrl ? new URL(String(articleUrl).trim()) : null
    if (parsed && (parsed.protocol === 'https:' || parsed.protocol === 'http:')) article = parsed.toString()
  } catch { /* not a link: the notes carry the thread alone */ }
  const lines = []
  const sentence = String(description ?? '').replace(/\s+/g, ' ').trim()
  if (sentence) lines.push(sentence, '')
  lines.push(`The Hacker News thread: ${thread}`)
  if (article) lines.push(`The article: ${article}`)
  lines.push('Commenters are heard under invented names.')
  return lines.join('\n')
}

/** The links an episode's notes carry, from its episode row: the thread, and the article when there is one. */
export function showNotesLinks(drama) {
  const threadUrl = drama?.url || (drama?.hnId ? `https://news.ycombinator.com/item?id=${drama.hnId}` : null)
  const articleUrl = drama?.articleUrl ?? drama?.sourceCompleteness?.article?.url ?? null
  return { threadUrl, articleUrl }
}

/**
 * The plan-approval body. Always empty: the series' standing approval IS the
 * approval, and HNR approves only after it has read that grant for its own key
 * (see HnrPipeline.requireStandingApproval). Revoking the grant stops the show.
 */
export const PLAN_APPROVAL_BODY = Object.freeze({})

/**
 * Whether the episode reached the feed. The episode row's `publishState` is the
 * record; the progress line is a second witness, because progress notes are
 * best-effort and a lost one must not make the nightly publish a second time.
 */
export function isPublishedToFeed(drama) {
  if (drama?.publishState === 'published' || drama?.releaseId) return true
  return (drama?.progress ?? []).some((entry) => entry?.message === PUBLISHED_PROGRESS_MESSAGE)
}

/** A finished MP3 that has not reached the feed: it needs the publish step and nothing else. */
export function needsPublishOnly(drama) {
  if (drama?.status !== 'ready' || !drama?.audioUrl || !drama?.artifactId) return false
  return !isPublishedToFeed(drama)
}
