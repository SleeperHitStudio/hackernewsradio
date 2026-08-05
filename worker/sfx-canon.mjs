/**
 * THE SFX WHITELIST. Eleven sounds, hardcoded, and nothing else — ever.
 *
 * The show generated 555 effects across 362 distinct labels before this existed:
 * 44 different wordings of Gary's one cable gag, 53 kinds of click, and a pile
 * of things a podcast studio does not contain (a pen plotter, a slamming door,
 * a balloon deflating). Worse, some of it broke the Series Bible outright — a
 * rimshot and a `Jazz Sting` are drums and horns, which the Bible bans because
 * ALL music lives in the theme bookends, and every one of them told the
 * listener where the joke was in a show whose whole rule is that nobody winks.
 *
 * So the model no longer decides what the show sounds like. It may still decide
 * WHERE a cue lands — the script motivates that — but the sound itself comes
 * from this table or the cue is switched off.
 *
 * NO NEW AUDIO IS EVER GENERATED. The SFX bank is keyed by prompt: an identical
 * prompt string returns the identical banked asset, exactly the way the jazz
 * theme does. `prompt` below is therefore a PRIMARY KEY, not a description —
 * editing one character orphans the bank entry and silently commissions a fresh
 * render. Change these only by deliberately banking a new asset first.
 */

/**
 * Matched top to bottom, so the specific entries come before the general ones:
 * `Key Tap` must win before `Keyboard clatter` claims anything with a key in
 * it, and the verdict stamp before the plain one.
 */
export const HNR_SFX_CANON = [
  {
    key: 'neon',
    label: 'Neon sign buzz',
    prompt: 'soft electronic buzzing of a neon sign',
    match: /neon/i,
  },
  {
    key: 'typewriter',
    label: 'Sparse typewriter',
    prompt: 'Sparse dry typewriter punctuation: one measured short typed phrase with a clear hesitation, then stop. Very few distinct keystrokes, no carriage-return bell, no rapid clicking, no loop, no buzz, no hum.',
    match: /typewriter/i,
  },
  {
    key: 'stamp_verdict',
    label: 'Final verdict stamp',
    prompt: 'One short definitive rubber stamp impact on a paper verdict. Single clean hit only, dry and concise. No metal clang, no double hit, no repeated clicks, no trailing rattle, no buzz, no hum.',
    // The closing stamp. Checked before the generic one so an end-of-episode
    // verdict does not get the cold-open sound.
    match: /stamp/i,
    requires: /verdict|final|closing|sign[- ]?off|outro|end/i,
  },
  {
    key: 'stamp',
    label: 'Cold-open stamp',
    prompt: 'One short definitive rubber stamp impact on paper. Single clean hit only, dry and concise. No double hit, no repeated clicks, no trailing rattle, no buzz, no hum.',
    match: /stamp/i,
  },
  {
    key: 'key_tap',
    label: 'Key Tap',
    prompt: 'third key tap sound',
    match: /key[- ]?tap/i,
  },
  {
    key: 'keyboard',
    label: 'Keyboard clatter',
    prompt: 'Mechanical keyboard keys clattering',
    match: /keyboard|keystroke|\bkeys?\b|typing/i,
  },
  {
    key: 'cable',
    // Gary unplugging his mic at peak fluster (worldRules 9). One sound, always.
    label: 'Cable pop and static crackle',
    prompt: 'sharp cable pop followed by a brief static crackle',
    match: /cable|static|crackle|unplug|disconnect|radio hiss|\bpop\b/i,
  },
  {
    key: 'click',
    // Every click in the show, including Gruner's throat dial (worldRules 8).
    label: 'Dial Click',
    prompt: 'heavy click of throat dial',
    match: /click|\bdial\b|relay|switch|snap|\bpen\b/i,
  },
  {
    key: 'paper',
    label: 'Page turn',
    prompt: 'A dry page being turned close to a microphone',
    match: /paper|page|rustle|notebook|logbook|turn/i,
  },
  {
    key: 'sigh',
    label: 'Sigh',
    prompt: 'soft human sigh',
    match: /sigh|exhale|inhale|breath|throat clear/i,
  },
  {
    key: 'tap',
    label: 'Tap',
    prompt: 'a light tablet screen tap, like a fingertip tapping glass',
    match: /tap/i,
  },
]

/** Every canonical prompt, for asserting the bank is never asked for anything else. */
export const HNR_SFX_PROMPTS = HNR_SFX_CANON.map((entry) => entry.prompt)

/**
 * Which canonical sound a generated cue becomes, or null to switch it off.
 *
 * Reads label AND prompt together: the model names a cue `Clunk` and then
 * describes a mug being set down, so the label alone throws away the evidence.
 */
export function resolveSfxCue(cue) {
  const description = `${cue?.label ?? ''} ${cue?.prompt ?? ''}`.trim()
  if (!description) return null
  for (const entry of HNR_SFX_CANON) {
    if (!entry.match.test(description)) continue
    if (entry.requires && !entry.requires.test(description)) continue
    return entry
  }
  return null
}

/**
 * Force an artifact's cues onto the whitelist.
 *
 * Rewrites a recognized cue to the canonical label+prompt (which reuses the
 * banked asset rather than rendering anything) and disables everything else.
 * Returns a summary so the episode's progress can say what it did instead of
 * silently rewriting the show's sound design.
 */
export async function enforceSfxCanon(sh, artifactId) {
  const cues = await sh.listSfxCues(artifactId)
  const summary = { total: cues.length, kept: 0, disabled: 0, byKey: {} }

  for (const cue of cues) {
    const entry = resolveSfxCue(cue)
    if (!entry) {
      // Not on the whitelist. It does not get quieter, it does not play.
      if (!cue.isDisabled) await sh.updateSfxCue(artifactId, cue.id, { isDisabled: true })
      summary.disabled += 1
      continue
    }
    const alreadyCanonical = cue.label === entry.label
      && cue.prompt === entry.prompt
      && !cue.isDisabled
    if (!alreadyCanonical) {
      await sh.updateSfxCue(artifactId, cue.id, {
        label: entry.label,
        prompt: entry.prompt,
        isDisabled: false,
      })
    }
    summary.kept += 1
    summary.byKey[entry.key] = (summary.byKey[entry.key] ?? 0) + 1
  }
  return summary
}
