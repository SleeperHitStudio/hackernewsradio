/**
 * The orchestrator. One HN URL in → a finalized MP3 out, driven entirely
 * through the Sleeper Hit Story API (the same pipeline the UI/CLI/MCP use).
 * We are a thin conductor: we hand the thread to Sleeper Hit's craft engine
 * with a tight creative brief and let it write, cast, score, and mix.
 *
 * The show is an off-center panel podcast with a FIXED recurring cast (HOSTS
 * below). The brief pins the cast by name; after each performance we pin the
 * VOICES too — the first episode adopts whatever voices the planner cast and
 * saves them (store key 'pinnedVoices'), and every later episode recasts to
 * that saved set so the hosts sound the same forever. Gruner (the alien) gets
 * his lines autotuned via the Story API's voice-modification effect.
 */
import { randomUUID } from 'node:crypto'
import { SleeperHit } from './sleeperhit.mjs'
import { config } from './config.mjs'
import { fetchThread, threadToTranscript } from './hn.mjs'
import { upsertDrama, patchDrama, findByHnIdAndMode, getSetting, setSetting, deleteOtherEpisodesOfThread } from './store.mjs'

const client = () => new SleeperHit({ baseUrl: config.apiBase, apiKey: config.apiKey })

// Podcast is the only mode. (The drama mode was deprecated — every thread
// becomes a podcast episode.)
export const MODES = ['podcast']
export function normalizeMode() {
  return 'podcast'
}

/**
 * Scale length to ENGAGEMENT (≈1 page ≈ 1 minute): comments carry most of the
 * signal, upvotes add heat. Floor 6 pages (~6 min) so even quiet threads get a
 * real episode; hot front-page threads roll up to 10–12 minutes. The 12-page
 * ceiling is set by the Story API's FIXED 13,500-token output budget on the
 * script draft (a tight rapid-fire page ≈ 1k tokens) — runPipeline downshifts
 * and re-plans if a draft still blows the budget.
 */
function pageTargetFor(thread) {
  const engagement = (thread.total || 0) + (thread.points || 0) / 2
  return Math.max(7, Math.min(12, Math.ceil(engagement / 20)))
}

/** The Story API's script writer ran out of output tokens mid-draft. */
const OUTPUT_BUDGET_RE = /output budget|finishReason=length/i

/**
 * The fixed, recurring cast — names only. The characters' full canon (bios,
 * wants, wounds, relationships, the jazz theme, world rules) lives in the
 * HNRadio project's SERIES BIBLE on the Sleeper Hit side (PATCH
 * /story-projects/{id}/series-bible), which the planner auto-loads for every
 * plan. The brief only reinforces the non-negotiables. pinHostVoices() keeps
 * voices identical across episodes; autotuneAlien() gives Gruner his sound.
 */
const HOSTS = [
  { name: 'GARY' },
  { name: 'MAEVE' },
  { name: 'OBI' },
  { name: 'GRUNER', alien: true },
]

/** Match a script/cast character label ("GARY", "Gary (host)") back to a host. */
function hostForCharacter(character) {
  const c = String(character || '').toUpperCase()
  return HOSTS.find((h) => c === h.name || new RegExp(`\\b${h.name}\\b`).test(c))
}

const SHARED_MUST_KNOW = [
  'The source is a real Hacker News comment thread; the people arguing in it are your raw material.',
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
// voicePreference biases the cast toward Cartesia (reliable live API).
const SHARED_STYLE_CONSTRAINTS = {
  musicPolicy:
    'Music is bookend-only and sparse: the show\'s recurring late-night JAZZ THEME (~30–40s) under the intro and ' +
    'outro, plus AT MOST one or two ~10s jazz stings mid-show. The vast majority of runtime is voices-only with NO ' +
    'music. SFX stay plentiful throughout; music does not.',
  voicePreference: 'Prefer Cartesia voices for the cast; avoid leaning on a single provider.',
}

/** The podcast: an off-center panel show with a fixed recurring cast. */
function podcastBrief(thread, pageTarget) {
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
        'swear constantly and casually. The comedy is RAPID-FIRE, absurd, and awkward — overlapping exchanges, ' +
        'interruptions, insane tangents, painful silences — played dead straight. Every episode opens with the ' +
        'same ritual: each host introduces themselves by name in one line, then straight into the thread. They read ' +
        'and react to the ACTUAL comments — quote them verbatim by handle — and derail into weird arguments. NO ' +
        'narrator or announcer: Gary opens cold and the hosts sign off themselves.',
      pageTarget,
      castNotes:
        'The project SERIES BIBLE is CANON — follow its characters exactly. The four recurring hosts, by NAME, every ' +
        'episode: GARY (failed founder), MAEVE (VC), OBI (Bangalore-born infra lifer), GRUNER (an alien intelligence ' +
        'trained only on Silicon Valley tech-bro culture; speaks in SHORT BURSTS — blunt interjections, field notes, ' +
        'an occasional 2-3 line run; still the least talkative host; Russian-accented, dropped articles, jargon slightly wrong, Russian swears) — ' +
        'plus at most ONE optional guest voicing the thread\'s most notable commenter. Voices clearly ' +
        'distinct: Obi an Indian-accented English voice; Gruner a DEEP RUSSIAN-accented English voice. Do NOT ' +
        'rename, merge, or replace them. NO NARRATOR or ANNOUNCER.',
      ...SHARED_AUDIO,
      mustKnowBeforeWriting: [
        ...SHARED_MUST_KNOW,
        'The cast is FIXED: GARY (failed founder), MAEVE (VC), OBI (infra lifer), and GRUNER (podcast-brained alien). Use exactly these hosts; play their satire straight.',
        'COLD-OPEN RITUAL: GARY STUMBLES INTO IT — mid-thought, flustered, slightly wrong, never smooth — then each ' +
        'host introduces themselves in order. No narrator; end with a clean host sign-off and no CTA.',
        'OBI IS MEAN TO GARY — cutting, personal, relentless, profane; Gary mostly absorbs it, wounded but polite. ' +
        'Specific cruelty beats shouting; Maeve and Gruner never intervene, which makes it worse.',
        'GRUNER\'S DIAL: when he REALLY means something he turns a dial on his throat — mark ONLY those lines with a ' +
        '(dial) parenthetical (often one of several consecutive GRUNER lines). NOBODY ever acknowledges it, ever.',
        'SWEAR CONSTANTLY — F-BOMBS ARE THE SHOW\'S PUNCTUATION, several per exchange: fuck, fucking, shit, goddamn; ' +
        'never bleeped, never apologized for. Maeve swears surgically; Gary swears mid-existential-spiral.',
        'The vibe is RAPID-FIRE, RIDICULOUS, and AWKWARD: quick overlapping exchanges, interruptions, absurd ' +
        'tangents, sudden painful silences, non sequiturs — irreverent all the way down, played completely straight.',
        'MUSIC IS THE SHOW\'S JAZZ THEME, bookends only: the SAME sleazy late-night jazz identity (~30–40s) opens ' +
        'and closes every episode, plus at most one or two ~10s stings — otherwise VOICES ONLY, no score under talk.',
      ],
    },
    styleConstraints: SHARED_STYLE_CONSTRAINTS,
    // Rides on the artifact request straight to SCRIPT GENERATION — the
    // planner summarizes the creative brief into a short blueprint, and the
    // profanity charter kept getting compressed down to the word "profane".
    performanceNotes:
      'PROFANITY IS A HARD REQUIREMENT of this show\'s voice, for a mature adult-comedy audience: the hosts drop ' +
      'F-BOMBS CONSTANTLY — at least one "fuck"/"fucking" per PAGE, plus regular "shit" and "goddamn", woven ' +
      'naturally into real reactions (never bleeped, never softened, never lampshaded). HARD LINE: never say ' +
      '"Jesus" or "Christ" in any form, from ANY host, ever. MAEVE SPEAKS FLUENT ' +
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
      'Gary\'s Bauxlite scars and Obi\'s contempt only surface when a specific comment triggers them — quote the ' +
      'comment, hit the bit in ONE sharp line, move on; never linger, never do backstory for its own sake. THE '
      + 'COMMENTERS ARE THE CELEBRITIES: satirize them by handle; GARY IS JEALOUS OF THEM (their karma, their '
      + 'exits, their shipped side projects) — Bauxlite gets AT MOST one line per episode. MAEVE drops a grand '
      + 'unified tech-history theory a few times per episode (Andreessen-scale, one step too far; the table goes '
      + 'silent, someone says "...what?", move on — different reference each episode). NO ' +
      'CATCHPHRASES OR STOCK INTENSIFIERS: "we are so back" and "on a Tuesday" are BANNED; if a phrase appears ' +
      'twice in one script, cut the second. Quote real commenters by handle and play everything dead straight.',
  }
}

function buildBrief(thread, pageTarget) {
  return podcastBrief(thread, pageTarget)
}

const stamp = () => new Date().toISOString()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Kick off a generation. Returns the drama record immediately (status 'queued')
 * and progresses it in the background so the frontend can poll. Dedupes by
 * (thread, mode) so a podcast and a drama of the same thread are distinct.
 */
export async function startGeneration(url, { force = false } = {}) {
  const mode = normalizeMode()
  const thread = await fetchThread(url)
  if (!force) {
    const existing = await findByHnIdAndMode(thread.id, mode)
    if (existing && existing.status === 'ready') return { drama: existing, reused: true }
  }

  const drama = {
    id: randomUUID(),
    hnId: thread.id,
    mode,
    url: thread.url,
    title: thread.title,
    commentCount: thread.total,
    status: 'queued',
    progress: [{ at: stamp(), message: `Fetched ${thread.total} comments` }],
    audioUrl: null,
    error: null,
    createdAt: stamp(),
  }
  await upsertDrama(drama)
  if (force) await deleteOtherEpisodesOfThread(thread.id, mode, drama.id)

  runPipeline(drama.id, thread).catch(async (err) => {
    await patchDrama(drama.id, {
      status: 'failed',
      error: err?.message || String(err),
      progress: await appendProgress(drama.id, `Failed: ${err?.message || err}`),
    })
  })

  return { drama, reused: false }
}

async function appendProgress(id, message) {
  const { getDrama } = await import('./store.mjs')
  const d = await getDrama(id)
  const progress = [...(d?.progress ?? []), { at: stamp(), message }]
  return progress
}

async function note(id, message) {
  await patchDrama(id, { progress: await appendProgress(id, message) })
}

async function runPipeline(id, thread) {
  const sh = client()
  const onProgress = (message) => { note(id, message) }
  const label = 'podcast'
  // No narrator — the hosts carry the show. 'suppress' makes the read speaker-only.
  const narrationPolicy = 'suppress'

  await patchDrama(id, { status: 'running' })

  // Reuse the one "HNRadio" project (config.hnRadioProjectId) so every drama is a
  // script/episode under a single project + feed. Fall back to a per-thread
  // project only when no HNRadio project is configured.
  let projectId = config.hnRadioProjectId
  if (projectId) {
    await note(id, 'Adding this episode to HNRadio…')
  } else {
    await note(id, 'Creating project…')
    projectId = await sh.createProject({ name: `HN ${label} — ${thread.title}`.slice(0, 120) })
  }
  await patchDrama(id, { projectId })

  await note(id, 'Adding the thread as source…')
  const sourceId = await sh.addTextSource(projectId, {
    content: threadToTranscript(thread),
    label: `HN thread ${thread.id}`,
  })
  await sh.pollSourceReady(projectId, sourceId, { onProgress })

  // Plan + perform, with an adaptive page target. The Story API's script
  // writer has a FIXED ~13.5k-token output budget per draft; if a draft blows
  // it (finishReason=length), retrying the SAME plan only helps once (their
  // writer gets "be more concise" feedback) — after that we re-plan smaller.
  // Plans are free; failed jobs refund credits.
  let pageTarget = pageTargetFor(thread)
  let artifactId = null

  for (let round = 1; artifactId === null; round++) {
    const brief = buildBrief(thread, pageTarget)

    // Plan generation is a structured-output LLM call and is occasionally
    // flaky. Plans don't spend credits, so re-roll a few times.
    let planId = null
    for (let attempt = 1; attempt <= 4; attempt++) {
      await note(id, attempt === 1
        ? `Planning the ${label} at ${pageTarget} pages (cast, scenes, music, SFX)…`
        : `Re-planning (attempt ${attempt})…`)
      try {
        const plan = await sh.createTableReadPlan(projectId, {
          title: brief.title,
          target: brief.target,
          creativeBrief: brief.creativeBrief,
          styleConstraints: brief.styleConstraints,
          sourceIds: [sourceId],
          narrationPolicy,
          notes: brief.performanceNotes,
        })
        await patchDrama(id, { planId: plan.id })
        const reviewed = await sh.pollPlanForReview(plan.id, { onProgress })
        if (reviewed.status === 'REQUIRES_APPROVAL') {
          await note(id, 'Approving the blueprint…')
          await sh.approvePlan(plan.id)
        }
        planId = plan.id
        break
      } catch (err) {
        if (attempt === 4) throw err
        await note(id, `Plan attempt ${attempt} failed (${err?.message || err}); retrying…`)
      }
    }

    // Run the generation job. Retry transient failures on the same plan; do
    // NOT retry a "time budget" failure (a retry won't help), and give an
    // output-budget overflow only ONE same-plan retry before bailing out to
    // re-plan at a smaller page target.
    await note(id, `Performing the ${label} — writing, voicing, scoring…`)
    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const jobId = await sh.createJob(planId, [
            { type: 'table_read', narrationPolicy, notes: brief.performanceNotes },
          ])
          await patchDrama(id, { jobId })
          artifactId = await sh.pollJobReady(jobId, { onProgress })
          break
        } catch (err) {
          const msg = err?.message || String(err)
          const overBudget = OUTPUT_BUDGET_RE.test(msg)
          const transient = !/time budget/i.test(msg)
          if (attempt === 3 || !transient || (overBudget && attempt >= 2)) throw err
          await note(id, `Performance attempt ${attempt} failed (${msg}); retrying…`)
        }
      }
    } catch (err) {
      const msg = err?.message || String(err)
      if (round < 3 && pageTarget > 4 && OUTPUT_BUDGET_RE.test(msg)) {
        pageTarget = Math.max(4, pageTarget - 3)
        await note(id, `Script blew the writer's output budget — re-planning tighter at ${pageTarget} pages…`)
        continue
      }
      throw err
    }
  }
  await patchDrama(id, { artifactId })

  // Pin the recurring cast to the same voices every episode (adopting them on
  // the first run), THEN autotune the alien — tuned renders are built from the
  // character's current voice, so the recast has to land first. Both steps are
  // best-effort: a hiccup shouldn't kill the episode.
  try {
    await note(id, 'Pinning the recurring host voices…')
    await pinHostVoices(sh, artifactId, onProgress)
  } catch (err) {
    await note(id, `Voice pinning skipped (${err?.message || err})`)
  }
  try {
    await note(id, 'Autotuning Gruner (the alien)…')
    const tuned = await autotuneAlien(sh, artifactId, onProgress)
    if (tuned) {
      // The renders are async — wait for them, retrying failed ranges (a queue
      // consumer with stale env can grab and fail jobs), then re-assert the
      // pinned cast. The re-assert is a deliberate cache-buster: the platform's
      // finalize reuses the voice track rendered at job time, and (as deployed)
      // the voice-mod worker does NOT invalidate that track — but the CAST
      // route does. Re-asserting identical voices forces the finalize to
      // rebuild the track, which is when the tuned clips get projected in.
      let tally = await sh.waitForVoiceModsSettled(artifactId, { onProgress })
      for (let round = 1; round <= 2 && tally.failed > 0; round++) {
        const retried = await sh.retryFailedVoiceMods(artifactId)
        onProgress?.(`autotune: retrying ${retried} failed range(s) (round ${round})`)
        tally = await sh.waitForVoiceModsSettled(artifactId, { onProgress })
      }
      if (tally.failed > 0) onProgress?.(`autotune: ${tally.failed} range(s) still failed — mixing without them`)
      // NOTE: no cache-buster here (for now). Forcing the finalize to rebuild
      // the voice track (via a single-voice recast) is how tuned clips would
      // get projected into the mix — but the deployed platform's projection
      // step currently produces clean TTS regardless (unresolved platform
      // bug), and the full Hume re-synth it forces caused 429s that killed
      // 3 of 4 episodes when the daily sweep finalized concurrently. The
      // tuned clips still render and persist on the artifact, so once the
      // platform's projection is fixed, re-finalizing an episode picks them
      // up. Re-add the recast buster then.
      onProgress?.('autotune: renders settled and stored on the artifact (projection awaits a platform fix)')
    }
  } catch (err) {
    await note(id, `Alien autotune skipped (${err?.message || err})`)
  }

  // Pin the canonical cartoon headshots (cropped from the show art) so the
  // table-read cast never shows generated photoreal portraits. Best-effort:
  // requires the Story API's cast entries[].avatarUrl support; older builds
  // ignore the field harmlessly.
  try {
    await sh.updateCast(artifactId, HOSTS.map((h) => ({
      character: h.name,
      avatarUrl: `https://hnradio.net/avatars/${h.name.toLowerCase()}.png`,
    })))
    onProgress?.('cast: canonical headshots pinned')
  } catch (err) {
    onProgress?.(`cast: headshot pin skipped (${err?.message || err})`)
  }

  // The Story API beds ~50% of scenes with music by default — far too much for a
  // talk podcast. Shape it to a sparse bookend (intro + outro only) before the
  // mix. Non-fatal: if shaping hiccups, we still finalize with whatever exists.
  try {
    await note(id, 'Shaping music to a sparse bookend…')
    await shapeMusicToBookends(sh, artifactId, onProgress)
  } catch (err) {
    await note(id, `Music shaping skipped (${err?.message || err})`)
  }

  await note(id, 'Mixing the durable MP3 (voices + music + SFX)…')
  const audioUrl = await sh.finalizeAudio(artifactId, { onProgress })

  await patchDrama(id, { status: 'ready', audioUrl, error: null })
  await note(id, `Done — your ${label} is ready.`)

  // A regenerated episode REPLACES older takes of the same thread — remove
  // them so the feed never shows duplicates. Best-effort.
  try {
    const removed = await deleteOtherEpisodesOfThread(thread.id, 'podcast', id)
    if (removed) await note(id, `Replaced ${removed} older episode(s) of this thread.`)
  } catch (err) {
    await note(id, `Old-episode cleanup skipped (${err?.message || err})`)
  }

  // Log the aired episode in the project's Series Bible episode map — the
  // bible is the show's canon, so what actually aired belongs there too.
  try {
    await logEpisodeInBible(sh, projectId, thread)
  } catch (err) {
    await note(id, `Series Bible episode log skipped (${err?.message || err})`)
  }

  // Publish to the podcast feed (settings key 'publishingSeriesId'; the RSS
  // feed is what Apple/Spotify/podcast apps poll). Best-effort.
  try {
    const seriesId = await getSetting('publishingSeriesId')
    if (seriesId) {
      await sh.publishEpisode(seriesId, { title: thread.title, artifactId })
      await note(id, 'Published to the HNR podcast feed.')
    }
  } catch (err) {
    await note(id, `Podcast publish skipped (${err?.message || err})`)
  }
}

/**
 * Keep the Series Bible's episode map in sync with what actually aired:
 * append one entry per produced thread, deduped by the HN item id label.
 */
async function logEpisodeInBible(sh, projectId, thread) {
  const doc = await sh.getSeriesBible(projectId)
  const episodes = Array.isArray(doc?.content?.episodes) ? [...doc.content.episodes] : []
  const label = `HN ${thread.id}`
  if (episodes.some((e) => e.label === label)) return
  episodes.push({
    id: randomUUID(),
    label,
    title: thread.title.slice(0, 200),
    summary: `Produced episode on the Hacker News thread "${thread.title}" (${thread.total} comments) — ${thread.url}`,
    status: 'produced',
  })
  await sh.patchSeriesBible(projectId, { content: { episodes } })
}

/**
 * Keep the hosts' voices identical across episodes. The Story API can't pin
 * voices at plan time (castNotes is free text), but it CAN recast a finished
 * read in place — so the FIRST episode adopts whatever voices the planner cast
 * for the four hosts (saved under the 'pinnedVoices' setting), and every later
 * episode batch-recasts its hosts back to that saved set. To re-roll the cast,
 * delete the 'pinnedVoices' row and the next episode adopts fresh voices.
 */
async function pinHostVoices(sh, artifactId, onProgress) {
  const cast = await sh.getCast(artifactId)
  const pinned = (await getSetting('pinnedVoices')) || {}
  const updates = []
  let adopted = 0
  for (const entry of cast) {
    const host = hostForCharacter(entry.character)
    if (!host) continue
    const want = pinned[host.name]
    if (!want?.voiceId) {
      pinned[host.name] = {
        voiceId: entry.voiceId,
        voiceName: entry.voiceName,
        ...(entry.gender ? { gender: entry.gender } : {}),
        ...(entry.provider ? { provider: entry.provider } : {}),
      }
      adopted++
    } else if (want.voiceId !== entry.voiceId) {
      updates.push({ character: entry.character, ...want })
    }
  }
  if (adopted) await setSetting('pinnedVoices', pinned)
  if (updates.length) {
    await sh.updateCast(artifactId, updates)
    onProgress?.(`cast: repinned ${updates.map((u) => u.character).join(', ')} to the recurring voices`)
  } else {
    onProgress?.(adopted
      ? `cast: adopted ${adopted} host voice(s) as the pinned set`
      : 'cast: already on the pinned voices')
  }
}

/**
 * Gruner's signature: every one of the alien's lines runs through the Story
 * API's autotune voice effect (the proven default recipe — key D, minor
 * pentatonic, chapel reverb) — the voicebox-converter sound, on top of the
 * German-accented voice the cast pins. The endpoint takes one CONTIGUOUS entry
 * range per call, so his scattered lines are grouped into runs. Renders are
 * async and queued; the music-shaping wait + finalize polling downstream give
 * them time to project onto the read before the mix.
 */
async function autotuneAlien(sh, artifactId, onProgress) {
  const cast = await sh.getCast(artifactId)
  const alien = cast.find((c) => hostForCharacter(c.character)?.alien)
  if (!alien) {
    onProgress?.('autotune: no alien in the cast')
    return
  }
  const entries = await sh.getCharacterEntries(artifactId, alien.character)
  // THE DIAL: Gruner speaks normally by default; only lines the writer marked
  // with a (dial) parenthetical get autotuned — his emphasis mechanism. Nobody
  // on the show ever acknowledges it.
  const marked = entries.filter((e) => /dial/i.test(e.parenthetical || ''))
  const indexes = [...new Set(marked.map((e) => e.entryIndex))].sort((a, b) => a - b)
  if (!indexes.length) {
    onProgress?.(`autotune: ${alien.character} kept the dial off this episode`)
    return 0
  }
  const runs = []
  for (const i of indexes) {
    const last = runs[runs.length - 1]
    if (last && i === last.end + 1) last.end = i
    else runs.push({ start: i, end: i })
  }
  for (const r of runs) {
    await sh.applyAutotune(artifactId, r.start, r.end)
    // A subtle mechanical click as he turns the throat dial, just before the
    // tuned words. Best-effort — a missing click never blocks the episode.
    try {
      await sh.addSfxCue(artifactId, {
        entryIndex: r.start,
        label: 'Dial Click',
        prompt: 'exactly one short, dry, definitive mechanical switch click — isolated single transient, no second click, no double-click, no ratchet, no sequence, no tail',
        volume: 0.42,
      })
    } catch { /* click optional */ }
  }
  onProgress?.(`autotune: ${alien.character} turned the dial — ${indexes.length} line(s) across ${runs.length} range(s)`)
  return runs.length
}

/**
 * Reduce the read's music to a bookend. The Story API's defined-clips mode beds
 * ~50% of scenes by default (opening + largest scenes), which is far too musical
 * for a talk podcast. We wait for those baseline beds to finish rendering, then
 * keep only the FIRST and LAST rendered beds (the open and the close) and mute
 * everything in between — leaving the middle of the show voices-only. We mute
 * existing beds rather than render new ones, so there's no slow/flaky Lyria
 * round-trip on the hot path. Best-effort: any hiccup just finalizes as-is.
 */
async function shapeMusicToBookends(sh, artifactId, onProgress) {
  const music = await sh.waitForMusicSettled(artifactId, { onProgress })
  if (music?.musicMode !== 'defined_clips') return // realtime mode: nothing to mute

  const total = Number(music.totalScenes) || 0
  if (total <= 1) return // single scene — its one bed is fine

  // Anchor the bookends to the ACTUAL ends of the show: scene 0 (intro) and the
  // FINAL scene (outro). The old keep-first/last-EXISTING-bed logic kept whatever
  // the 50% coverage happened to score last — often a mid-scene bed — and left
  // the real ending dry. (Beds play once at ~30-40s via the Story API, so a kept
  // bed is a bookend, not a full-scene wash.)
  const introIndex = 0
  const outroIndex = total - 1
  const keep = new Set([introIndex, outroIndex])

  // THE THEME IS BANKED: the first successful jazz render saves its intro and
  // outro bed audio URLs (settings key 'jazzTheme'); every later episode
  // INJECTS those exact files as ready clips — the identical recording every
  // episode, no Lyria render, no music-billing dependency. Delete the
  // 'jazzTheme' settings row to re-roll the theme on the next episode.
  try {
    const banked = await getSetting('jazzTheme')
    let injected = false
    if (banked?.intro?.soundUrl && banked?.outro?.soundUrl) {
      onProgress?.('music: installing the banked jazz theme bookends')
      await sh.setDefinedClip(artifactId, introIndex, {
        soundUrl: banked.intro.soundUrl,
        ...(banked.intro.durationMs ? { durationMs: banked.intro.durationMs } : {}),
        playMode: 'once',
      })
      await sh.setDefinedClip(artifactId, outroIndex, {
        soundUrl: banked.outro.soundUrl,
        ...(banked.outro.durationMs ? { durationMs: banked.outro.durationMs } : {}),
        playMode: 'once',
        // Align the outro bed to FINISH at the show's end — without this it
        // plays at the final scene's head and fades out a minute early.
        anchor: 'end',
      })
      // VERIFY the injection took — a Story API build without clip.soundUrl
      // support silently ignores the field, which would ship a silent episode.
      const check = await sh.getMusic(artifactId)
      const ok = (i, url) => (check.definedClips ?? []).some(
        (c) => c.sceneIndex === i && c.status === 'ready' && c.soundUrl === url,
      )
      injected = ok(introIndex, banked.intro.soundUrl) && ok(outroIndex, banked.outro.soundUrl)
      if (!injected) onProgress?.('music: banked-theme injection not supported by the API yet — falling back to a fresh render')
    }
    if (!injected) {
      await sh.setMusicDirective(artifactId, {
        prompt:
          'The show theme: sleazy late-night jazz — walking upright bass, brushed drums, smoky saxophone, a touch ' +
          'of Rhodes; slow, too cool for the content, played straight.',
      })
      onProgress?.(`music: rendering the jazz theme bookends (scenes ${introIndex} + ${outroIndex})`)
      await sh.regenerateMusicScenes(artifactId, [...keep], { onProgress })
      // Anchor the outro bed to the END of the final scene (best-effort; the
      // API ignores unknown fields on older builds).
      try { await sh.setDefinedClip(artifactId, outroIndex, { anchor: 'end' }) } catch { /* older API */ }
      // Bank this render as THE theme for all future episodes.
      const state = await sh.getMusic(artifactId)
      const clipFor = (i) => (state.definedClips ?? []).find((c) => c.sceneIndex === i && c.status === 'ready' && c.soundUrl)
      const intro = clipFor(introIndex)
      const outro = clipFor(outroIndex)
      if (intro && outro) {
        await setSetting('jazzTheme', {
          intro: { soundUrl: intro.soundUrl, durationMs: intro.durationMs ?? null },
          outro: { soundUrl: outro.soundUrl, durationMs: outro.durationMs ?? null },
          bankedAt: new Date().toISOString(),
        })
        onProgress?.('music: jazz theme BANKED — future episodes reuse these exact recordings')
      }
    }
  } catch (err) {
    onProgress?.(`music: jazz bookends skipped (${err?.message || err})`)
  }

  // Disable every non-bookend bed, then VERIFY — a late worker write can
  // re-materialise a muted bed, so re-disable any offenders across a few passes
  // until only the intro + outro beds remain audible.
  let lastMuted = 0
  for (let pass = 0; pass < 4; pass++) {
    const state = await sh.getMusic(artifactId)
    const offenders = (state.definedClips ?? []).filter(
      (c) => c.status === 'ready' && !keep.has(c.sceneIndex) && !c.disabled,
    )
    if (offenders.length === 0) break
    for (const c of offenders) await sh.setDefinedClip(artifactId, c.sceneIndex, { disabled: true })
    lastMuted += offenders.length
    await sleep(4000) // let any in-flight worker write land, then re-verify
  }
  onProgress?.(`music: bookended — intro(scene ${introIndex}) + outro(scene ${outroIndex}), muted ${lastMuted} middle bed${lastMuted === 1 ? '' : 's'}`)
}
