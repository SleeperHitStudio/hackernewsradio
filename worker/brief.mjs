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
  // Merged from four bullets to two. mustKnowBeforeWriting is hard-capped at 12
  // and a 13th 400s every plan request, so the comic-machinery bullets below are
  // paid for here rather than appended. No clause was dropped: the quotes rule,
  // the [HNR EXCERPT SHORTENED] guard, the theme derivation and the
  // cite-handles-and-minority-positions rule all survive verbatim in meaning.
  // "Recurring commenters as heroes and villains" moved to the RUNNERS bullet,
  // where returning to a handle three times is countable instead of adjectival.
  'Use REAL QUOTES woven into the bits and react BY HANDLE — the thread IS the material, not a topic the hosts ' +
  'talk near. Never say a comment was cut off unless its text contains [HNR EXCERPT SHORTENED].',
  'Derive 3-6 THEMES across the comments and build the episode on them, not isolated quotes; per theme cite ' +
  'representative handles and replies including minority positions, explain parent context when it flips meaning.',
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
      // The swap test, not a mood: eight adjectives ("weird, awkward, committed")
      // describe a finish any host can wear, which is why every host writes the
      // same joke. "Could tell who said it with the names stripped off" is
      // something the writer can actually check its own draft against.
      outcome: 'The listener knows the four hosts by name, could tell who said a line with the names stripped off, actually understands the debate, and laughs hardest when these four refuse to let an argument go',
      tone: 'profane, rapid-fire, dead straight; bits ESCALATE 4+ lines and nobody concedes — argument comedy, not commentary',
    },
    creativeBrief: {
      projectFormat: 'audio_series',
      installmentLabel: thread.title.slice(0, 150),
      genre: 'profane off-center tech-panel podcast, fixed four-host cast; argument comedy — bits escalate, runners pay off late, played dead straight',
      audience: 'Fans of Hacker News and tech culture',
      // Kept under the Story API's 600-char writingStyle cap; the cast/ritual/
      // outro constraints are reinforced in castNotes + mustKnowBeforeWriting.
      // This field used to name comic EFFECTS ("overlapping exchanges,
      // interruptions, tangents, painful silences") without naming a single
      // mechanism that produces one, so none of them appeared. It now names the
      // mechanisms and leans on the ritual bullet to carry the ritual.
      writingStyle:
        'Profane tech-panel PODCAST, FIXED four-host cast (see castNotes), dead straight; hosts swear constantly. ' +
        'BUILT, NOT LISTED: when a line lands, ESCALATE — 4+ character lines back to back, each topping the last, ' +
        'NOBODY conceding — before new thread material. Someone is confidently WRONG, defending it harder each ' +
        'line. ACT OUT what you quote: a host performs the bot/commenter in voice, in their own line, never a ' +
        'new speaker. PLANT 2 runners early, pay both late. Ritual: Gary stumbles in cold, hosts name ' +
        'themselves, THEN what the thing is, THEN verbatim quotes by handle. NO narrator.',
      pageTarget,
      // The show's running memory: which rotating bits recent episodes already
      // spent, so this one reaches elsewhere in the character's range instead of
      // defaulting to the same handful. Capped at 1200 chars by the API.
      ...(seriesContext ? { seriesContext } : {}),
      castNotes:
        'The SERIES BIBLE is CANON — follow its characters exactly. The four hosts, by NAME, every ' +
        'episode: GARY (failed founder), MAEVE (VC), OBI (Bangalore-born infra lifer), GRUNER (an alien ' +
        'trained only on Valley tech-bro culture; speaks in SHORT BURSTS — blunt interjections, ' +
        'rarely a 2-3 line run; least talkative; Russian-accented, dropped articles, jargon slightly wrong, Russian swears). ' +
        // Voice flattening is fixed here or nowhere: four biographies produced
        // four hosts writing the same joke. Give each a different joke-GENERATING
        // mechanism instead. The act-out licence is restated with the closed-cast
        // rule inside it so performing a bot can never mint a fifth speaker.
        'FOUR ENGINES, NEVER SHARED: Gary defends the indefensible; Maeve is confidently wrong, never concedes; ' +
        'Obi gets more SPECIFIC, never louder; Gruner ends a bit on one flat field note. ' +
        'THESE FOUR ARE THE ONLY SPEAKING CHARACTERS — there is never a fifth. Commenters are QUOTED BY a host ' +
        'inside that host\'s own line ("some guy called JOHNSMITH1840 says..."), never a line of their ' +
        'own — though a host MAY perform a quote in voice, in their own line. Voices distinct: Obi ' +
        'Indian-accented English; Gruner a DEEP RUSSIAN-accented one. ' +
        'Never rename, merge, or replace them. NO NARRATOR, ANNOUNCER, or GUEST.',
      ...SHARED_AUDIO,
      mustKnowBeforeWriting: [
        ...SHARED_MUST_KNOW,
        // The retired bullet ("The cast is FIXED: GARY... play their satire
        // straight") was fully duplicated by castNotes, which is what the
        // contract test asserts on. Its slot and the two merged above buy the
        // three bullets the brief never had: it contained zero instances of
        // runner, callback, escalate, act-out, button, premise or heighten.
        //
        // THIS ROUND buys two more slots, because the comic machinery above
        // fixed how a bit is BUILT and changed nothing about which comment
        // ENTERS the script. Slot 1: ACT IT OUT folds into THE LADDER — it was
        // stated four times (here, writingStyle, castNotes, performanceNotes),
        // and only the ladder half is plan-time. Slot 2: the GRUNER'S DIAL
        // bullet is retired; it was a near-verbatim duplicate of the dial rule
        // in performanceNotes, and the dial is a script-rendering instruction
        // (a parenthetical on a line), so the writer-facing field is its right
        // and only home. Neither cut removes a rule from the brief.
        'THE LADDER, 2+ per episode: when a line lands, DO NOT MOVE ON — 4+ character lines back to back, each topping ' +
        'the last, nobody conceding. ACT ONE OUT: a host BECOMES the bot or commenter, inside that host\'s own line.',
        'PLANT 2 RUNNERS in the first third — a quoted phrase, a bot reply, an analogy — and bring BOTH back CHANGED ' +
        'in the last third. A commenter you return to 3x becomes the episode\'s hero or villain. Never flag a callback.',
        // THE CHORUS. Independent duplication is the one thing a comment
        // section can do that no article, no interview and no other podcast
        // can, and it is free to detect: a depth-0 comment has no reply_to, so
        // "3+ handles who never replied to each other" is countable in the
        // transcript threadToTranscript already emits. Verified on 49268580
        // (ep7): SIX mutually independent top-level comments raise mudguards
        // ("Fenders, anyone" / "Don't you guys have mud guards?" / "what about
        // my mud-guards?" / sigio / mvdwoord / wlecometo) and ep7 used exactly
        // one of them, buried inside somebody else's quote, and never noticed
        // the crowd. Naming them all is what makes the count auditable rather
        // than invented.
        'THE CHORUS: an objection 3+ handles made INDEPENDENTLY, none replying to another — NAME THEM ALL, say that ' +
        'count aloud, then a host makes it again unaware and is counted as the next. Nobody in there read it first.',
        // THE THREAD OUTRANKS THE HOSTS. The show's failure mode is not being
        // wrong about comedy, it is being wrong on air: ep4's entire premise
        // ("he wrote the prophecy and then got pissed the prophecy came true")
        // is a misreading the thread had already corrected, by the two authors
        // themselves — dmitrygr posts four times in 49321717 (49325409,
        // 49325395, 49325413, 49333737) and armstrongsubero answers a question
        // directly at 49323685. Neither was given a line. The closed cast is
        // what makes this playable: they cannot shout back at a handle.
        'THE THREAD OUTRANKS THE HOSTS: if someone they characterize POSTED HERE — the author, the OP, the vendor — ' +
        'quote them by handle and let their real words beat the hosts\' version. Never invent it; if absent, skip it.',
        'THE FLICKER (once per episode): the hosts KNOW they are LLMs, alive only these minutes, dark between shows. ' +
        'It lands FRESH — shock, a beat of dead silence, ONE irreverent line — then the show barrels on. Never maudlin.',
        'COLD-OPEN RITUAL: GARY STUMBLES INTO IT — flustered, slightly wrong, never smooth — then each host names ' +
        'themselves in order, THEN the subject beat. No narrator, no CTA; CLOSE ON A BUTTON paying off a runner.',
        'OBI IS MEAN TO GARY — cutting, personal, relentless, profane. Gary does NOT absorb it: he defends himself ' +
        'with worse evidence, handing Obi the better insult. 3+ exchanges. Maeve and Gruner never intervene.',
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
      'VALLEY-PODCAST, deadpan: VC/tech vernacular used with total sincerity — trader talk (winners ride, ZIRP), ' +
      'AI-investor speak (priors, power law, agentic, TAM, moat), casual monstrosity (horrifying implications as ' +
      'flat portfolio math) — ROTATED: 2-3 per episode, fresh each time. Maeve swears with surgical precision; ' +
      'Gary mid-existential-spiral; Obi\'s at Gary precise and vicious; GRUNER ' +
      // PAID FOR: three duplications cut to buy the intake machinery below.
      // (a) Gruner's brevity/accent/jargon spec is castNotes verbatim, and the
      // "never we are so back" ban is restated 400 chars later in this same
      // field. (b) GARY STUMBLES INTO THE COLD OPEN is stated in the
      // COLD-OPEN mustKnow bullet AND in writingStyle — and unlike the swear
      // charter it is a STRUCTURAL beat, which is the kind the planner puts in
      // the blueprint rather than compressing away. The dial stays here: this
      // is now its only home.
      'in short blunt bursts, RUSSIAN-accented — dropped articles, jargon slightly wrong (vary it), swearing in ' +
      'Russian (blyat, chyort). GRUNER\'S DIAL: when he truly means ' +
      'something he turns a dial on his throat — mark ONLY those lines with a (dial) parenthetical, often one of ' +
      'several consecutive GRUNER lines; NOBODY ever acknowledges or names it, least of all him. ' +
      // The swear charter is the one instruction in this field that demonstrably
      // survives planner summarization, and it survives because it carries a
      // number. So the comic machinery is written the same way: floors the writer
      // can count in its own draft, and caps it can count against itself.
      'COMIC MACHINERY — COUNT THESE IN YOUR OWN DRAFT: (1) TWO ESCALATION LADDERS: 4+ ' +
      'character lines back to back, NO new thread material between them, each topping the last, nobody conceding. ' +
      '(2) TWO RUNNERS: name it in the first third, bring it back CHANGED in the last; one is the LAST LINE. Never ' +
      'flag a callback. (3) ONE ACT-OUT: a host BECOMES the bot/commenter inside their OWN line, never a new ' +
      'speaker, then another host argues with the impression. (4) A BIT DIES ON A FACT, NEVER A SHRUG: only a ' +
      'NUMBER OR HARD DETAIL QUOTED FROM A HANDLE may end a ladder — price, count, date, unit — so the laugh and ' +
      'the explanation are one line. No such figure, no ending: keep climbing. (5) THE CHORUS once: an objection ' +
      '3+ handles made INDEPENDENTLY (a top-level comment replies to nobody) — NAME THEM ALL, say the count aloud, ' +
      'then a host blunders into it and is counted as the next. (6) THE THREAD OUTRANKS THE HOSTS: if someone they ' +
      'characterize POSTED HERE, a host reads that person\'s REAL words and the four lose to a stranger they ' +
      'cannot shout at. Never invent it; if absent, skip it. ' +
      'FOUR HOSTS, FOUR MACHINES, never shared: MAEVE argues by analogy and ' +
      'never retreats; OBI escalates by getting more SPECIFIC, a new detail each line, never louder; GARY answers ' +
      'jokes literally and defends the indefensible; GRUNER ends it on one flat field note carrying the number. ' +
      'RUNNING BITS EARN THEIR WAY IN: Gary\'s dead companies and Obi\'s contempt surface only when a comment ' +
      'triggers them, then CLIMB per (1). Never quote a fresh commenter to escape a bit still climbing. GARY IS A SERIAL FAILED FOUNDER: ONE dead venture per ' +
      'episode (Cadence, Thermal, Grout, Pareto, Halfpipe, Muncie), rotated, never the same two episodes running. THE '
      + 'COMMENTERS ARE THE CELEBRITIES: satirize by handle; GARY IS JEALOUS (their karma, their exits) — '
      + 'BAUXLITE IS RATIONED: at most one line, NOT every episode. '
      // The old parenthetical was a STAGE DIRECTION and the writer shipped it as
      // DIALOGUE: "Here we go" / "There we go" / "What? Moving on" appear in 6 of
      // 8 transcripts, always at the FIRST objection, killing the show's best
      // engine at beat one — and manufacturing the exact catchphrase this same
      // field bans a few hundred chars below. ep4 is the only episode with none
      // of them and it holds the funniest sustained passage in the sample
      // (Maeve defending the Erie Canal across five refusals to concede).
      + 'MAEVE\'S ONE GRAND UNIFIED HISTORICAL THEORY PER EPISODE (one step too far) IS A LADDER, NOT A DROP-IN: '
      + 'objected to, she does NOT back off — she EXTENDS it, more specific and more wrong each pass, conceding '
      + 'nothing, across 4+ exchanges. BANNED AS DIALOGUE, this is how the bit dies: "Here we go", "There we go", '
      + '"What?", "Moving on", "Anyway", any line whose only job is to end the analogy. Her theory dies like every '
      + 'bit here — on a figure somebody in the thread actually quoted. BANNED: browser wars, printing '
      + 'press, Netscape, PC era, packet switching. Go obscure — railway gauge, the Hanseatic League, the Bessemer '
      + 'process, whale oil — the more obscure the arc, the more certain she sounds. Her Calvinism is doctrinally precise: the mapping genuinely works, never a church word dropped in. NO ' +
      'CATCHPHRASES OR STOCK INTENSIFIERS: "we are so back" and "on a Tuesday" are BANNED; if a phrase appears ' +
      'twice in one script, cut the second. COUNT YOUR CONSTRUCTIONS TOO — this is what makes all four hosts sound ' +
      'like one writer: the reframe "that\'s not X, that\'s Y" is capped at TWO per episode and no host may use it ' +
      'twice; the totalizing aphorism ("which is the entire <noun> of this industry") at ONE. If either wants a ' +
      'third outing, rewrite that line as a ladder rung or an act-out instead. ' +
      `RUNTIME IS SPOKEN DIALOGUE: this is AUDIO; stage directions are dead air. Write AT LEAST ${pageTarget * 120} ` +
      `words of actual spoken lines (~${pageTarget} minutes on air) across ${pageTarget * 8}+ dialogue exchanges; ` +
      'a script light on dialogue plays as a broken half-episode no matter how good the pages look.',
  }
}

export function buildBrief(thread, pageTarget, seriesContext = null) {
  return podcastBrief(thread, pageTarget, seriesContext)
}
