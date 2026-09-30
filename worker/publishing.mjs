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

export const EPISODE_DESCRIPTION_DIRECTION = 'Write one pithy sentence, 20-40 words, that sells this specific episode. Be irreverent, playful, and sharp, but use no profanity. Lead with the transcript’s actual tension, argument, or absurdity. Avoid host roll calls, generic show boilerplate, and phrases like “the hosts discuss” or “this episode explores.”'

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
