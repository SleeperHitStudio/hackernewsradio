/**
 * The podcast feed side of HNR, shared by the pipeline and the nightly.
 *
 * HNR is an UNATTENDED producer. It publishes, and approves its plans, under
 * the PublishingSeries' standing approval — a grant bound to HNR's API key that
 * the owner can revoke — and never by claiming a human `userConfirmed` it did
 * not get. See readiness.mjs for how the grant is read.
 */

/** Progress line the nightly reads as proof an episode reached the feed. Keep verbatim. */
export const PUBLISHED_PROGRESS_MESSAGE = 'Published to the HNR podcast feed.'

export const EPISODE_DESCRIPTION_DIRECTION = 'Write one pithy sentence, 20-40 words, that sells this specific episode. Be irreverent, playful, and sharp, but use no profanity. Lead with the transcript’s actual tension, argument, or absurdity. Avoid host roll calls, generic show boilerplate, and phrases like “the hosts discuss” or “this episode explores.”'

/**
 * The plan-approval body. Under the series' standing approval HNR approves
 * WITHOUT a confirmation claim — the grant is the approval, and revoking it is
 * how the owner stops the show. Until the platform reports a grant, HNR sends
 * the confirmation it always has, so plan approval keeps working meanwhile.
 */
export function planApprovalBody(approval) {
  return approval?.granted ? {} : { userConfirmed: true }
}

/** A finished MP3 that has not reached the feed: it needs the publish step and nothing else. */
export function needsPublishOnly(drama) {
  if (drama?.status !== 'ready' || !drama?.audioUrl || !drama?.artifactId) return false
  return !(drama.progress ?? []).some((entry) => entry?.message === PUBLISHED_PROGRESS_MESSAGE)
}
