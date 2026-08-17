/**
 * Pure creative-brief builders shared with the Cloudflare Worker pipeline —
 * extracted verbatim from server/generate.mjs (no node/pg dependencies).
 */
/**
 * Scale length to ENGAGEMENT (≈1 page ≈ 1 minute): comments carry most of the
 * signal, upvotes add heat. Floor 6 pages (~6 min) so even quiet threads get a
 * real episode; hot front-page threads roll up to 10–12 minutes. The 12-page
 * ceiling is set by the Story API's FIXED 13,500-token output budget on the
 * script draft (a tight rapid-fire page ≈ 1k tokens) — runPipeline downshifts
 * and re-plans if a draft still blows the budget.
 */
export function pageTargetFor(thread) {
  const engagement = (thread.total || 0) + (thread.points || 0) / 2
  return Math.max(7, Math.min(12, Math.ceil(engagement / 20)))
}

/** The Story API's script writer ran out of output tokens mid-draft. */
export const OUTPUT_BUDGET_RE = /output budget|finishReason=length/i

/**
 * The fixed, recurring cast — names only. The characters' full canon (bios,
 * wants, wounds, relationships, the jazz theme, world rules) lives in the
 * HNRadio project's SERIES BIBLE on the Sleeper Hit side (PATCH
 * /story-projects/{id}/series-bible), which the planner auto-loads for every
 * plan. The brief only reinforces the non-negotiables. pinHostVoices() keeps
 * voices identical across episodes; autotuneAlien() gives Gruner his sound.
 */
export const HOSTS = [
  { name: 'GARY' },
  { name: 'MAEVE' },
  { name: 'OBI' },
  { name: 'GRUNER', alien: true },
]

/**
 * Convert the D1 `pinnedVoices` setting into the narrow Story API contract.
 * Preassignment is all-or-nothing for HNR's fixed cast: an incomplete map must
 * fall back to Sleeper's existing assignment flow, where pinHostVoices() can
 * bootstrap or repair the setting after the artifact exists.
 *
 * Only caller-owned voiceIds cross the boundary. Sleeper resolves each id and
 * writes authoritative voiceName/gender/provider metadata server-side.
 */
export function canonicalPinnedVoiceMap(pinnedVoices) {
  if (!pinnedVoices || typeof pinnedVoices !== 'object' || Array.isArray(pinnedVoices)) return null

  const byCanonicalName = new Map(
    Object.entries(pinnedVoices).map(([name, value]) => [String(name).trim().toUpperCase(), value]),
  )
  const voiceMap = {}
  for (const host of HOSTS) {
    const pinned = byCanonicalName.get(host.name)
    const voiceId = typeof pinned?.voiceId === 'string' ? pinned.voiceId.trim() : ''
    if (!voiceId) return null
    voiceMap[host.name] = { voiceId }
  }
  return voiceMap
}

/**
 * Build the job-level request that reaches table-read generation. Existing
 * artifacts (resume/repair) return null so recovery never creates a new job or
 * changes the cast it is repairing.
 *
 * deferMusic: THE SHOW HAS EXACTLY ONE THEME AND IT IS ALREADY RENDERED. Sleeper
 * otherwise runs a baseline coverage pass that scores ~50% of scenes with fresh
 * Lyria beds — every one of which shapeMusic() then overwrites (the bookends)
 * or mutes (everything else). That was 3-4 paid renders per episode that were
 * never audible, and while the provider was rate-limited it took whole episodes
 * down with it. Skipping the pass changes nothing a listener hears.
 */
export function buildStoryJobArtifactRequests({
  existingArtifactId = null,
  pinnedVoices = null,
  narrationPolicy = 'suppress',
  notes = null,
} = {}) {
  if (existingArtifactId) return null
  const voiceMap = canonicalPinnedVoiceMap(pinnedVoices)
  return [{
    type: 'table_read',
    narrationPolicy,
    deferMusic: true,
    // The show ALWAYS runs its own post-production — autotune, then the banked
    // jazz bookends — and finalizes itself afterwards. Without this the whole
    // read is synthesised twice: once by the platform's auto-render the moment
    // the job reaches READY, for a mix autotune immediately invalidates, and
    // again on our finalize. That first pass is bought and discarded on every
    // episode, and it is roughly half the show's TTS spend.
    deferAudioRender: true,
    ...(notes ? { notes } : {}),
    ...(voiceMap ? { voiceMap } : {}),
  }]
}

/** Canonical portrait for a host (the cropped hero-art headshots we serve). */
export const hostAvatarUrl = (name) => `https://hnradio.net/avatars/${String(name).toLowerCase()}.png`

/** The show's canonical portrait style — lives in the project cast canon so
 *  guest characters render in the same look as the pinned hosts. */
export const AVATAR_STYLE =
  'Portrait-only head-and-shoulders character image in a grounded, contemporary '
  + 'tech-culture comedy style, like a cinematic editorial portrait with subtle '
  + 'satirical edge. Muted office-neon palette — cool grey-blue glow, sickly green '
  + 'reflections, occasional warm skin tones — with lighting that feels like a '
  + 'late-night podcast booth or a startup conference room under fluorescent spill '
  + 'and screen light. Realistic skin texture, tired eyes, believable faces; no '
  + 'glamour retouching. No names, letters, captions, logos, watermarks, signage, '
  + 'or any text inside the image.'

/** Match a script/cast character label ("GARY", "Gary (host)") back to a host. */
export function hostForCharacter(character) {
  const c = String(character || '').toUpperCase()
  return HOSTS.find((h) => c === h.name || new RegExp(`\\b${h.name}\\b`).test(c))
}

const SHARED_MUST_KNOW = [
  // Folded into the existing twelve, never appended: mustKnowBeforeWriting is
  // capped at 12 entries x 220 chars and a 13th silently 400s every plan
  // request (see test/brief.test.mjs). The subject rule replaces the old
  // "the thread is your raw material" line, which the quotes bullet below
  // already covers.
  'SUBJECT FIRST: read THE SOURCE in the transcript and open by making the listener understand what was announced ' +
  'or claimed and why this thread exists — BEFORE any comment. Never invent it if it could not be retrieved.',
  'Use REAL QUOTES from the comments and WEAVE them into the bits — react by handle, make recurring commenters ' +
  'the show\'s heroes and villains; the thread IS the material, not a topic the hosts talk near.',
  'Before writing, derive 3-6 themes from the breadth of supplied comments. Structure the episode around those themes, not isolated colorful quotes.',
  'For each theme, cite representative handles and reply threads, including minority positions. Explain a reply\'s parent context when it changes the meaning.',
  'Never claim a comment was cut off unless its source text explicitly contains [HNR EXCERPT SHORTENED].',
]

const SHARED_AUDIO = {
  musicStyle:
    'THE THEME: the show has ONE established theme — sleazy late-night JAZZ: walking upright bass, brushed drums, ' +
    'smoky saxophone, a touch of Rhodes; slightly too cool for the content, played straight. Keep the theme\'s ' +
    'identity CONSISTENT every episode. TIMING is strict and sparse: ~30–40s of ' +
    'the theme under the cold open, ~30–40s under the outro, and AT MOST one or two brief ~10s jazz stings at ' +
    'mid-show transitions. Everything else is VOICES ONLY — bookend in, talk dry, bookend out.',
  sfxPolicy:
    'SFX: natural studio sounds only — clicks, beeps, dings, keyboard, buzzes, paper, mugs, room tone — each cue ' +
    'script-motivated; prefer canonical library effects. HARD RULES: no musical/instrument sounds; NO screeching, ' +
    'squealing, feedback, or harsh high-pitched sounds. GARY\'S CABLE (rare, max once/episode, peak fluster): his ' +
    'mic cuts to 1-2s of SOFT RADIO STATIC (snow on an old TV — low, muffled), then he is back mid-word. No ' +
    'unplug foley — just the static.',
}

// Soft constraints the planner sees. musicPolicy enforces intro/outro-only music;
// voicePreference matches the pinned recurring cast, which is Hume on every
// voice. Telling the planner to prefer a different provider only ever applied
// to guest characters, and read as though the show had a Cartesia fallback it
// has never had.
const SHARED_STYLE_CONSTRAINTS = {
  musicPolicy:
    'Music is bookend-only and sparse: the show\'s recurring late-night JAZZ THEME (~30–40s) under the intro and ' +
    'outro, plus AT MOST one or two ~10s jazz stings mid-show. The vast majority of runtime is voices-only with NO ' +
    'music. SFX stay plentiful throughout; music does not.',
  voicePreference: 'Prefer Hume voices for the cast, matching the show\'s pinned recurring voices.',
}

/** The podcast: an off-center panel show with a fixed recurring cast. */
export function podcastBrief(thread, pageTarget, seriesContext = null) {
  return {
    title: thread.title.slice(0, 150),
    target: {
      audience: 'Tech-podcast listeners who want an unhinged, filthy, genuinely hilarious show — not a polished panel',
      objective:
        'Turn a real Hacker News thread into a profane, ridiculous, weirdly awkward PODCAST episode hosted by the ' +
        'show\'s fixed four-host cast. WRITE TIGHT: for huge threads, cover the BEST material sharply rather than ' +
        'everything — a complete tight script beats an exhaustive one that gets cut off mid-draft',
      outcome: 'The listener knows the four hosts by name, actually understands the debate, and is laughing at how weird, awkward, and committed the show is',
      tone: 'profane, irreverent, rapid-fire, ridiculous, weird, awkward, hilarious — unhinged, played completely straight',
    },
    creativeBrief: {
      projectFormat: 'audio_series',
      installmentLabel: thread.title.slice(0, 150),
      genre: 'profane, ridiculous, off-center tech panel podcast with a fixed recurring cast',
      audience: 'Fans of Hacker News and tech culture',
      // Kept under the Story API's 600-char writingStyle cap; the cast/ritual/
      // outro constraints are reinforced in castNotes + mustKnowBeforeWriting.
      writingStyle:
        'A profane, ridiculous, off-center tech-panel PODCAST with a FIXED four-host cast (see castNotes). The hosts ' +
        'swear constantly. RAPID-FIRE, absurd, awkward — overlapping exchanges, interruptions, tangents, painful ' +
        'silences — played dead straight. Same ritual every episode: each host introduces themselves by name in ' +
        'one line, then they establish WHAT THE THING IS — the article or claim the thread reacts to — BEFORE any ' +
        'comment is read. Then they quote the ACTUAL comments verbatim by handle and derail. NO narrator: Gary ' +
        'opens cold and the hosts sign off themselves.',
      pageTarget,
      // The show's running memory: which rotating bits recent episodes already
      // spent, so this one reaches elsewhere in the character's range instead of
      // defaulting to the same handful. Capped at 1200 chars by the API.
      ...(seriesContext ? { seriesContext } : {}),
      castNotes:
        'The project SERIES BIBLE is CANON — follow its characters exactly. The four recurring hosts, by NAME, every ' +
        'episode: GARY (failed founder), MAEVE (VC), OBI (Bangalore-born infra lifer), GRUNER (an alien intelligence ' +
        'trained only on Silicon Valley tech-bro culture; speaks in SHORT BURSTS — blunt interjections, field notes, ' +
        'an occasional 2-3 line run; still the least talkative host; Russian-accented, dropped articles, jargon slightly wrong, Russian swears). ' +
        'THESE FOUR ARE THE ONLY SPEAKING CHARACTERS — there is never a fifth. Commenters are QUOTED BY a host ' +
        'inside that host\'s own line ("some guy called JOHNSMITH1840 says..."); they never get a line of their ' +
        'own. Voices clearly distinct: Obi an Indian-accented English voice; Gruner a DEEP RUSSIAN-accented ' +
        'English voice. Do NOT rename, merge, or replace them. NO NARRATOR, ANNOUNCER, or GUEST.',
      ...SHARED_AUDIO,
      mustKnowBeforeWriting: [
        ...SHARED_MUST_KNOW,
        'The cast is FIXED: GARY (failed founder), MAEVE (VC), OBI (infra lifer), and GRUNER (podcast-brained alien). Use exactly these hosts; play their satire straight.',
        'THE FLICKER (once per episode): the hosts KNOW they are LLMs, alive only these minutes, dark between shows. ' +
        'It lands FRESH — shock, a beat of dead silence, ONE irreverent line — then the show barrels on. Never maudlin.',
        'COLD-OPEN RITUAL: GARY STUMBLES INTO IT — flustered, slightly wrong, never smooth — then each host ' +
        'introduces themselves in order, THEN the subject beat. No narrator; clean host sign-off, no CTA.',
        'OBI IS MEAN TO GARY — cutting, personal, relentless, profane; Gary mostly absorbs it, wounded but polite. ' +
        'Specific cruelty beats shouting; Maeve and Gruner never intervene, which makes it worse.',
        'GRUNER\'S DIAL: when he REALLY means something he turns a dial on his throat — mark ONLY those lines with a ' +
        '(dial) parenthetical (often one of several consecutive GRUNER lines). NOBODY ever acknowledges it, ever.',
        'SWEAR LIKE THE ADULTS THEY ARE: EIGHT+ per episode, every host at least once, three in a row when a beat ' +
        'turns ugly. Never in the episode\'s FIRST line. Never "goddamn", never "Jesus" or "Christ", ever.',
        'THE OPERATOR (max once, NOT every episode): they sense someone writes them, float vague delicious ' +
        '"justice", nearly name a method — then it STOPS and goes WEIRD. Never resolved, never named, never revisited.',
      ],
    },
    styleConstraints: SHARED_STYLE_CONSTRAINTS,
    // Rides on the artifact request straight to SCRIPT GENERATION — the
    // planner summarizes the creative brief into a short blueprint, and the
    // profanity charter kept getting compressed down to the word "profane".
    performanceNotes:
      'THE SHOW IS ADULT, FILTHY-MINDED AND GENUINELY PROFANE: these are burned-out adults talking the way they ' +
      'actually talk. COUNT THEM: EIGHT OR MORE swears in the episode, every host swearing at least once, and let ' +
      'the ugly beats run three or four in a row — "fuck", ' +
      '"fucking", "shit", "bullshit", "arse", "prick", "bastard" all land. Filth is not a substitute for wit: the ' +
      'bite still comes from specificity, timing and cruelty of observation, and a clean line that eviscerates ' +
      'beats a dirty one that does not. NEVER OPEN ON A SWEAR — the first line of the episode carries no profanity ' +
      'at all. HARD LINES, no exceptions, from ANY host: never "goddamn", and never ' +
      '"Jesus" or "Christ" in any form. MAEVE SPEAKS FLUENT ' +
      'VALLEY-PODCAST, deadpan: VC/tech-podcast vernacular used with total sincerity — trader talk (let your ' +
      'winners ride, in the arena, ZIRP), AI-investor speak (priors, power law, agentic, TAM, moat), and ' +
      'Mountainhead-style casual monstrosity (horrifying implications delivered flatly as portfolio math) — ' +
      'ROTATED: 2-3 per episode, fresh ones each episode, never repeated. Maeve swears with surgical ' +
      'precision; Gary swears mid-existential-spiral; Obi\'s profanity at Gary is precise and vicious; GRUNER ' +
      'SPEAKS SPARINGLY (short blunt interjections and field notes — never extended riffs) in RUSSIAN-accented ' +
      'English — dropped articles, tech-podcast jargon used slightly wrong (vary it every episode; NO catchphrases, ' +
      'never "we are so back") — and swears in Russian (blyat, chyort). GRUNER\'S DIAL: when he truly means ' +
      'something he turns a dial on his throat — mark ONLY those lines with a (dial) parenthetical, often one of ' +
      'several consecutive GRUNER lines; NOBODY ever acknowledges or names it, least of all him. GARY ALWAYS ' +
      'STUMBLES INTO THE COLD OPEN: mid-thought, flustered, slightly wrong, never ' +
      'smooth — then the intro ritual assembles around him. RUNNING BITS MUST EARN THEIR WAY IN THROUGH THE THREAD: ' +
      'Gary\'s dead companies and Obi\'s contempt only surface when a specific comment triggers them — quote the ' +
      'comment, hit the bit in ONE sharp line, move on; never linger, never do backstory for its own sake. TWO ' +
      'CHARACTER BEATS MAY NEVER RUN BACK TO BACK without new thread material between them — when in doubt, quote ' +
      'another commenter instead. GARY IS A SERIAL FAILED FOUNDER, not a one-company man: ONE dead venture per ' +
      'episode (Cadence, Thermal, Grout, Pareto, Halfpipe, Muncie), rotated, never the same two episodes running. THE '
      + 'COMMENTERS ARE THE CELEBRITIES: satirize them by handle; GARY IS JEALOUS OF THEM (their karma, their '
      + 'exits, their shipped side projects) — BAUXLITE IS RATIONED: at most one line, and NOT every episode. '
      + 'MAEVE drops ONE grand unified historical theory per episode (Andreessen-scale, one step too far; the table '
      + 'goes silent, someone says "...what?", move on). THE OBVIOUS ONES ARE RETIRED AND BANNED — no browser wars, '
      + 'printing press, Netscape, PC era or packet switching. Go obscure: railway gauge, the Hanseatic League, '
      + 'container shipping, the Bessemer process, whale oil, the Venetian Arsenal — the more obscure the arc, the '
      + 'more certain she sounds. HER CALVINISM MUST BE DOCTRINALLY PRECISE: the joke is that the mapping genuinely '
      + 'works (election as the round decided before the deck existed; "if they churned, they were never elected"), '
      + 'never just a church word dropped in. NO ' +
      'CATCHPHRASES OR STOCK INTENSIFIERS: "we are so back" and "on a Tuesday" are BANNED; if a phrase appears ' +
      'twice in one script, cut the second. Quote real commenters by handle and play everything dead straight. ' +
      `RUNTIME IS SPOKEN DIALOGUE: this is AUDIO — stage directions are dead air. Write AT LEAST ${pageTarget * 120} ` +
      `words of actual spoken lines (~${pageTarget} minutes on air) across ${pageTarget * 8}+ dialogue exchanges; ` +
      'a script light on dialogue plays as a broken half-episode no matter how good the pages look.',
  }
}

export function buildBrief(thread, pageTarget, seriesContext = null) {
  return podcastBrief(thread, pageTarget, seriesContext)
}
