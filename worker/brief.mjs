/**
 * Pure creative-brief builders shared with the Cloudflare Worker pipeline —
 * extracted verbatim from server/generate.mjs (no node/pg dependencies).
 */
/**
 * Every episode is about 12 pages, about 12 minutes on air (owner, 2026-10-02: "flat ~12 pages for
 * every HNR episode"). Length used to scale with engagement (7-12 pages), and the platform's coverage
 * gate measures the draft against this one number, so a varying target only varied how far a draft
 * missed it. runPipeline still downshifts and re-plans if a draft blows the output budget.
 */
export const EPISODE_PAGE_TARGET = 12

export function pageTargetFor(_thread) {
  return EPISODE_PAGE_TARGET
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

/** The show's hard lines, from any host, ever. The punch-up pass is refused a scene that adds one. */
export const SHOW_NEVER_SAY = Object.freeze(['goddamn', 'Jesus', 'Christ'])

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
    // The platform's punch-up pass (Sleeper #958): after the screenplay is written, each scene is
    // edited so the lines land and the swearing sits on the beat, and a scene keeps the edit only if
    // its quotes, its slugline, its speakers and its length survive and it introduces none of the
    // show's hard lines. Measured on two episodes: 14 swears each from all four hosts (was 3 and 0),
    // and a blind judge preferred it 4 of 4.
    punchUp: true,
    neverSay: [...SHOW_NEVER_SAY],
    // The show never opens on a swear. The platform's guard (Sleeper #986) keeps a punched opening scene
    // only if its first spoken line stays clean; the writer's own first line is never changed.
    firstLineClean: true,
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

/**
 * The hosts as the project CAST CANON should hold them: the portrait HNR serves
 * and, once the show has pinned one (`pinnedVoices`), the voice.
 *
 * The canon is where the platform looks for a character's voice before it lets
 * a table read start, so a host with a pinned voice that the canon does not
 * carry is a read the platform cannot voice. Only fields the canon schema
 * accepts are sent — it is strict, and the portrait-style key HNR used to send
 * beside `characters` 400'd every PATCH from 07-15 on (897 times), silently,
 * which is why the canon has faces for the hosts and no voices.
 */
export function castCanonCharacters(pinnedVoices) {
  const byName = new Map(
    Object.entries(pinnedVoices && typeof pinnedVoices === 'object' ? pinnedVoices : {})
      .map(([name, value]) => [String(name).trim().toUpperCase(), value]),
  )
  return HOSTS.map((host) => {
    const pinned = byName.get(host.name)
    const voiceId = typeof pinned?.voiceId === 'string' ? pinned.voiceId.trim() : ''
    const voiceProvider = typeof pinned?.provider === 'string' ? pinned.provider.trim() : ''
    return {
      name: host.name,
      avatarUrl: hostAvatarUrl(host.name),
      ...(voiceId ? { voiceId } : {}),
      ...(voiceId && voiceProvider ? { voiceProvider } : {}),
    }
  })
}

/**
 * The desired hosts the stored canon does not already match, compared on the
 * CHARACTERS only (a person is found by name or any alias, case-insensitive).
 * An empty result means the canon is current and nothing is written.
 */
export function staleCastCanonCharacters(canon, desired) {
  const stored = new Map()
  for (const character of Array.isArray(canon?.content?.characters) ? canon.content.characters : []) {
    const names = [character?.name, ...(Array.isArray(character?.aliases) ? character.aliases : [])]
    for (const name of names) {
      if (typeof name === 'string' && name.trim()) stored.set(name.trim().toUpperCase(), character)
    }
  }
  return desired.filter((want) => {
    const have = stored.get(String(want.name).toUpperCase())
    if (!have) return true
    return Object.entries(want).some(([field, value]) => field !== 'name' && have[field] !== value)
  })
}

/** Match a script/cast character label ("GARY", "Gary (host)") back to a host. */
export function hostForCharacter(character) {
  const c = String(character || '').toUpperCase()
  return HOSTS.find((h) => c === h.name || new RegExp(`\\b${h.name}\\b`).test(c))
}

// THE COMEDY REWRITE (owner, 2026-10-02: "make that show much funnier but still on brand, and a bit
// more swearing"). The old brief was ~4,900 chars of counted mechanics, bans and caps with one sentence
// on what is funny, and the Series Bible beside it rationed the swearing ("a SPICE") and stopped every
// bit after one line. It shipped 2 swears and ~10 "that's not X, that's Y" reframes an episode, and
// coverage scored all of it 8/10. The brief now leads with the joke and keeps only the numbers a writer
// can use; the Bible (v122) carries the same comedy rules. Capped at 12 x 220 chars (test/brief.test.mjs).
const SHARED_MUST_KNOW = [
  'SUBJECT FIRST: open by making the listener understand what was announced or claimed and why this thread exists, BEFORE any comment, and make that setup funny. Never invent it if it could not be retrieved.',
  'QUOTES ARE SETUPS: the SHORTEST verbatim sentence that carries the joke, handle first; the next line is a punchline, never a summary. Never say a comment was cut off unless it contains [HNR EXCERPT SHORTENED].',
  'Build on 3-5 THEMES from the comments, not isolated quotes; cite representative handles including minority positions, and explain parent context when it flips the meaning, as a joke.',
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
  // The writer's spoken-word budget for the length line: ~185 spoken words a page leaves room for cues.
  const spokenWords = Math.round((pageTarget * 185) / 50) * 50
  return {
    title: thread.title.slice(0, 150),
    target: {
      audience: 'Tech-podcast listeners who want an unhinged, filthy, genuinely hilarious show — not a polished panel',
      objective:
        'Turn a real Hacker News thread into a profane, very funny PODCAST episode hosted by the show\'s fixed four-host cast: ' +
        'a laugh every few lines, built on what the thread actually argued. WRITE TIGHT: cover the BEST material sharply ' +
        'rather than everything.',
      outcome:
        'The listener laughed out loud several times, could tell who said a line with the names stripped off, and still ' +
        'understands what the thread was fighting about and who was right',
      tone: 'very funny, filthy-mouthed, rapid-fire, played dead straight; bits climb 4-8 lines and nobody concedes',
    },
    creativeBrief: {
      projectFormat: 'audio_series',
      installmentLabel: thread.title.slice(0, 150),
      genre: 'profane tech-panel comedy podcast, fixed four-host cast; argument comedy where every bit climbs and ends on a laugh',
      audience: 'Fans of Hacker News and tech culture',
      // Kept under the Story API's 600-char writingStyle cap.
      writingStyle:
        'COMEDY FIRST, fixed four-host cast (see castNotes), dead straight, swearing about once a page. A laugh every 3-4 ' +
        'lines. QUOTE, PUNCHLINE, LADDER: shortest verbatim quote by handle; the next line is a joke about it; the others ' +
        'TOP it on the same comment, 4-8 lines, nobody conceding, ending on a hard detail from the thread. Specific beats ' +
        'general. No speeches, no sincere confessions, no explaining a joke, no aphorism endings. Every scene ends on its ' +
        'biggest laugh. NO narrator.',
      pageTarget,
      // The show's running memory: which rotating bits recent episodes already spent. Capped at 1200 chars.
      ...(seriesContext ? { seriesContext } : {}),
      castNotes:
        'The SERIES BIBLE is CANON — follow its characters and COMEDY RULES exactly. Four hosts, by NAME, every episode: ' +
        'GARY (failed founder), MAEVE (VC), OBI (Bangalore-born infra lifer), GRUNER (alien trained only on Valley tech-bro ' +
        'culture; under ten words a line, Russian-accented, dropped articles, jargon slightly wrong, Russian swears). ' +
        'FOUR JOKE MACHINES, NEVER SHARED: Gary takes it literally and defends it with worse evidence; Maeve turns horror ' +
        'into flat portfolio math and doubles down; Obi gets more SPECIFIC, never louder, and goes for Gary; Gruner lands ' +
        'it in under ten words, wrong idiom, right conclusion. THESE FOUR ARE THE ONLY SPEAKING CHARACTERS. Commenters are ' +
        'QUOTED BY a host inside that host\'s own line; a host MAY perform one in voice, never as a new speaker. Obi ' +
        'Indian-accented; Gruner deep Russian. NO NARRATOR, ANNOUNCER, or GUEST.',
      ...SHARED_AUDIO,
      mustKnowBeforeWriting: [
        ...SHARED_MUST_KNOW,
        'THE LADDER, 3+ per episode: when a line lands, DO NOT MOVE ON — 4-8 lines on the same comment, each topping the ' +
        'last, nobody conceding. ACT ONE OUT: a host BECOMES the commenter, in voice, inside their own line.',
        'PLANT 2 RUNNERS in the first third (a quoted phrase, a number, an analogy) and bring BOTH back CHANGED in the last ' +
        'third; the episode\'s last line is a runner payoff. Never flag a callback on air.',
        'THE CHORUS (when the thread has one): 3+ handles who made the same objection independently. Name them all, then a ' +
        'host makes it again without noticing. Play it; never call it "a chorus" on air.',
        'THE THREAD OUTRANKS THE HOSTS: if someone they mock POSTED HERE (author, OP, vendor), quote their real words and ' +
        'let the four lose to a stranger they cannot shout at. Never invent it; if absent, skip it.',
        'NO PATHOS ON AIR: wounds surface only as jokes someone else tramples. The Flicker (once): a shock, one irreverent ' +
        'line, then straight back to a joke. Never maudlin, no confessions, no speech over 30 words.',
        'COLD OPEN: GARY STUMBLES INTO IT, flustered and slightly wrong; each host names themselves in order; then the ' +
        'subject beat. No narrator, no CTA. Every scene, and the episode, ends on its biggest laugh.',
        'OBI GOES FOR GARY: cutting, personal, technically precise, profane. Gary defends himself with worse evidence and ' +
        'hands Obi the better insult. 3-5 exchanges. Maeve and Gruner never intervene.',
        'SWEAR LIKE THE ADULTS THEY ARE: 10+ per episode, every host at least twice, on the stressed beat of the joke; ' +
        'never in the first line; never "goddamn", "Jesus" or "Christ"; never at a private commenter as a person.',
        'THE OPERATOR (max once, NOT every episode): they sense someone writes them, float vague delicious "justice", ' +
        'nearly name a method — then it STOPS and goes WEIRD. Never resolved, never named, never revisited.',
      ],
    },
    styleConstraints: SHARED_STYLE_CONSTRAINTS,
    // Rides on the artifact request straight to SCRIPT GENERATION (artifactRequests[0].notes, capped at
    // 5000 chars). The platform repeats it after every scene's rules and hands it to the punch-up pass,
    // so it is read where each scene is written. Purpose first: what is funny, then the few numbers.
    performanceNotes: [
      'THIS IS A COMEDY. Every line is a laugh or the setup for the next one: aim for a laugh every three or four lines, start to finish. Four burned-out adults in a booth at 2am, tearing into a real Hacker News thread and swearing the way adults actually swear. Smart, filthy, fast. The listener still learns what the thread was arguing about, because the facts are the setups.',
      '',
      'HOW A BIT WORKS. A host reads the SHORTEST verbatim sentence that carries the joke, handle first. The very next host line is a PUNCHLINE about it, never a description of it ("that\'s a sad sentence" describes; it doesn\'t land). Then the others TOP it on the SAME comment: each rung more specific, more personal or more wrong, 4 to 8 lines, nobody conceding. It ends when someone loses, or on a hard detail from the thread (a price, a count, a date, a version number). Three ladders an episode at least. Then a new comment.',
      '',
      'FOUR MACHINES; a line only one of them could say:',
      'GARY takes it literally, defends the indefensible with worse evidence, and loses. His dead companies are punchlines with receipts, never confessions.',
      'MAEVE turns any horror into portfolio math, in a dead monotone. Her grand historical theory gets MORE specific and MORE wrong each time it\'s challenged; it never retreats, and it dies on a number from the thread.',
      'OBI gets more specific, never louder: the exact version, the exact pager time, the exact config flag. He goes for Gary, and when Gary defends himself Obi keeps climbing.',
      'GRUNER: under ten words, wrong idiom, right conclusion. He reads a field note aloud at most twice an episode; otherwise he just talks.',
      '',
      'SWEARING: at least ten swears, about one a page, every host at least twice. Swearing is rhythm: put the swear on the stressed beat, so it IS the punchline word or the brake right before it. Let an ugly exchange run three in a row. Each host swears their own way. Maeve: rarely and in dead monotone, so hers land hardest. Gary: in spirals. Obi: precise compound insults aimed at Gary. Gruner: in Russian (blyat, chyort, suka) or in broken English. Words that land: fuck, fucking, shit, bullshit, prick, bastard, arse, dickhead. Never in the first line. Never "goddamn", "Jesus" or "Christ". Never at a private commenter as a person: go after their argument, the company, the founder, or each other.',
      '',
      'CUT ON SIGHT:',
      '- speeches over 30 words;',
      '- sincere confessions (a host\'s wound surfaces only as a joke, and an earnest line is trampled by the next line);',
      '- explaining a joke after it lands;',
      '- naming the machinery on air ("that\'s a chorus", "a callback", "I\'m logging it");',
      '- the reframe "that\'s not X, that\'s Y" (once an episode, total);',
      '- ending a scene on an aphorism or a moral;',
      '- "What?", "Moving on", "Back to the thread" and "Anyway" as exits;',
      '- stage directions like "Silence." or "Nobody moves". On air that is dead air, so interrupt instead: (OVERLAPPING) five or six times an episode, at the top of a ladder.',
      '',
      'BUTTONS. Every scene ends on its biggest laugh. Plant two runners in the first third; the last line of the episode pays one off, changed.',
      '',
      'KEEP:',
      '- Gary stumbles into the cold open; the hosts name themselves.',
      '- Subject first: Gary fumbles it, Obi fixes it, and both are funny.',
      '- Quotes are verbatim by handle. A wrong fact gets corrected by another host, as a joke.',
      '- The Flicker happens once: a shock, one irreverent line, then straight back to a joke.',
      '- No narrator, no guest.',
      '',
      'ONE SCENE AT A TIME: these notes describe the WHOLE episode, and you are writing one scene of it. Each signature bit (a field note read aloud, one of Gary\'s dead companies, the chorus, the Flicker, Maeve\'s theory, the operator) happens ONCE in the episode, in the scene whose outline names it. If this scene\'s outline does not name it, leave it out.',
      '',
      `LENGTH: about ${pageTarget} pages, roughly ${spokenWords.toLocaleString('en-US')} spoken words. Mostly short lines, under 15 words. A scene's page budget is a ceiling as well as a floor.`,
    ].join('\n'),
  }
}

export function buildBrief(thread, pageTarget, seriesContext = null) {
  return podcastBrief(thread, pageTarget, seriesContext)
}
