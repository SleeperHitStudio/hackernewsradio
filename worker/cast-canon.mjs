/**
 * The ONE place HNR writes its hosts into the project CAST CANON.
 *
 * The canon is where the platform looks for a character's voice before it lets
 * a table read start, and the readiness preflight judges the cast from it. HNR
 * owns the hosts' voices (D1 `pinnedVoices`), so both the preflight (before it
 * lets a `cast_not_ready` verdict stop the show) and the pipeline's "ensure
 * cast canon" step push them through here: otherwise a canon missing a voice
 * HNR has pinned stops every tick, and the pipeline that would write it never
 * runs.
 */
import { castCanonCharacters, staleCastCanonCharacters } from './brief.mjs'
import { getSetting } from './store.mjs'

/**
 * Push the hosts' portraits and pinned voices into the cast canon. One GET; a
 * PATCH only of the hosts that differ, compared on the characters alone. It is
 * free (no credits) and never invents a voice: a host with no voice in
 * `pinnedVoices` is sent with its portrait only.
 *
 * Returns the names it wrote ([] when the canon was already current). A Story
 * API refusal is THROWN, never swallowed: the old catch-all hid a 400 on every
 * PATCH for ten weeks.
 */
export async function syncCastCanonFromPins(db, sh, projectId, { readSetting = getSetting } = {}) {
  const desired = castCanonCharacters(await readSetting(db, 'pinnedVoices'))
  const stale = staleCastCanonCharacters(await sh.getCastCanon(projectId), desired)
  if (!stale.length) return []
  await sh.patchCastCanon(projectId, { characters: stale })
  return stale.map((character) => character.name)
}
