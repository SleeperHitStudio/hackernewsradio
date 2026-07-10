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
import { upsertDrama, patchDrama, findByHnIdAndMode, getSetting, setSetting } from './store.mjs'

const client = () => new SleeperHit({ baseUrl: config.apiBase, apiKey: config.apiKey })

// Podcast is the only mode. (The drama mode was deprecated — every thread
// becomes a podcast episode.)
export const MODES = ['podcast']
export function normalizeMode() {
  return 'podcast'
}

/**
 * Scale length to the size of the debate (≈1 page ≈ 1 minute). The ceiling is
 * set by the Story API's FIXED 13,500-token output budget on the script draft
 * (finishReason=length kills anything bigger): a tightly written rapid-fire
 * page runs ~1k tokens, so 12 pages fits with margin — but only if the writer
 * stays terse (the brief demands it), so runPipeline also downshifts the page
 * target and re-plans whenever a draft still blows the budget.
 */
function pageTargetFor(commentCount) {
  return Math.max(4, Math.min(12, Math.ceil(commentCount / 18)))
}

/** The Story API's script writer ran out of output tokens mid-draft. */
const OUTPUT_BUDGET_RE = /output budget|finishReason=length/i

/**
 * The fixed, recurring cast. The planner is briefed to cast EXACTLY these four
 * by name every episode; pinHostVoices() then keeps their voices identical
 * across episodes, and autotuneAlien() gives the alien his signature sound.
 */
const HOSTS = [
  {
    name: 'GARY',
    bio: 'human man, 40s; ex-founder still quietly processing the pen-plotter startup that ruined him; deadpan, kind, faintly haunted; opens every show',
  },
  {
    name: 'MAEVE',
    bio: 'human woman; ex-security-researcher energy; surgically precise and unsettlingly calm; says devastating things politely',
  },
  {
    name: 'OBI',
    bio: 'Lagos-born infrastructure engineer; grounded, allergic to hype; openly MEAN to Gary — cutting, relentless dry contempt; civil to everyone else',
  },
  {
    name: 'GRUNER',
    bio: 'an ALIEN field researcher; his implanted voicebox converter mapped his native tongue closest to German — he speaks English with a HEAVY German accent; polite, formal, slightly wrong about idioms',
    alien: true,
  },
]

/** Match a script/cast character label ("GARY", "Gary (host)") back to a host. */
function hostForCharacter(character) {
  const c = String(character || '').toUpperCase()
  return HOSTS.find((h) => c === h.name || new RegExp(`\\b${h.name}\\b`).test(c))
}

const SHARED_MUST_KNOW = [
  'The source is a real Hacker News comment thread; the people arguing in it are your raw material.',
  'Use REAL QUOTES from the comments wherever possible — keep their wording, voice, and personality.',
]

const SHARED_AUDIO = {
  musicStyle:
    'Sonic palette: modern, electronic, tech-forward — synth-driven, never orchestral or a cheerful jingle; MOOD ' +
    'adapts to THIS thread (tense = darker/driving, playful = brighter, reflective = cooler). TIMING is strict and ' +
    'sparse: a ~30–40s intro bed under the cold open, a ~30–40s outro bed at the close, and AT MOST one or two brief ' +
    '~10s stings to punctuate a mid-show transition. Everything else is VOICES ONLY — the large majority of the ' +
    'episode has NO music. Bookend in, talk dry, bookend out.',
  sfxPolicy:
    'Use discrete sound effects to punctuate the show — notification dings, keyboard clatter, phone buzzes, UI clicks, ' +
    'a door, ambient room tone, light transitions between segments. Keep them grounded and purposeful rather than ' +
    'cartoonish — NO rimshots, record scratches, or punchline stingers (that is the try-hard comedy we are avoiding). ' +
    'Prefer common, canonical effects so they reuse from the shared library, and punctuate transitions cleanly.',
}

// Soft constraints the planner sees. musicPolicy enforces intro/outro-only music;
// voicePreference biases the cast toward Cartesia (reliable live API).
const SHARED_STYLE_CONSTRAINTS = {
  musicPolicy:
    'Music is bookend-only and sparse: ~30–40s under the intro, ~30–40s under the outro, plus AT MOST one or two ' +
    '~10s punctuation stings mid-show. The vast majority of runtime is voices-only with NO music. SFX stay plentiful ' +
    'throughout; music does not.',
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
        'EXACTLY these FOUR recurring hosts, every episode, cast by NAME — plus at most ONE optional guest voicing ' +
        'the thread\'s most notable commenter. ' +
        HOSTS.map((h, i) => `${i + 1}) ${h.name} — ${h.bio}.`).join(' ') +
        ' Voices must be clearly distinct: Gary and Obi obviously different male voices; Gruner a German-accented ' +
        'English voice. Do NOT rename, merge, or replace them. NO NARRATOR or ANNOUNCER.',
      ...SHARED_AUDIO,
      mustKnowBeforeWriting: [
        ...SHARED_MUST_KNOW,
        'The cast is FIXED and recurring: GARY, MAEVE, OBI, and GRUNER host EVERY episode. Use exactly these four ' +
        'names as the speakers; do not rename, merge, or replace them.',
        'COLD-OPEN RITUAL: every episode opens the same way — each host introduces themselves by name in one line, ' +
        'in order (Gary, Maeve, Obi, Gruner), then straight into the thread. It should be slightly awkward every time.',
        'OBI IS MEAN TO GARY — cutting, personal, relentless, profane; Gary mostly absorbs it, wounded but polite. ' +
        'Specific cruelty beats shouting; Maeve and Gruner never intervene, which makes it worse.',
        'GRUNER speaks English through his voicebox converter: HEAVY German accent, German-inflected word order, and ' +
        'he SWEARS IN GERMAN (Scheiße, verdammt, ach du lieber Gott). He never explains or acknowledges any of this.',
        'SWEAR CONSTANTLY, with AMPLE F-BOMBS: fuck, fucking, shit, goddamn — like punctuation, never bleeped, ' +
        'never apologized for. Maeve swears with surgical precision; Gary swears mid-existential-spiral.',
        'The vibe is RAPID-FIRE, RIDICULOUS, and AWKWARD: quick overlapping exchanges, interruptions, absurd ' +
        'tangents, sudden painful silences, non sequiturs — irreverent all the way down, played completely straight.',
        'ENGAGING FIRST: under the chaos the episode must be genuinely interesting — the listener should actually ' +
        'understand the thread\'s debate by the end, and be hooked the whole way through.',
        'MUSIC IS SPARSE: a ~30–40s intro bed, a ~30–40s outro bed, and at most one or two ~10s mid-show stings — ' +
        'otherwise VOICES ONLY. Most of the episode has no music at all; do not run a continuous score under the talk.',
        'NO narrator/announcer — Gary opens the show cold, in character, and END with a clean host sign-off: wrap ' +
        'up fully, do not trail off mid-sentence.',
        'The outro is just a genuine wrap-up of THIS discussion. Do NOT invent a next episode, tease future shows, ' +
        'ask listeners to like/subscribe/follow/rate, or use any podcast-outro CTA clichés.',
      ],
    },
    styleConstraints: SHARED_STYLE_CONSTRAINTS,
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
  let pageTarget = pageTargetFor(thread.total)
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
          const jobId = await sh.createJob(planId)
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
      const pinned = (await getSetting('pinnedVoices')) || {}
      const cast = await sh.getCast(artifactId)
      const reassert = cast
        .filter((e) => hostForCharacter(e.character) && pinned[hostForCharacter(e.character).name]?.voiceId)
        .map((e) => ({ character: e.character, ...pinned[hostForCharacter(e.character).name] }))
      if (reassert.length) await sh.updateCast(artifactId, reassert)
      onProgress?.('autotune: settled — cast re-asserted so the mix rebuilds with the tuned takes')
    }
  } catch (err) {
    await note(id, `Alien autotune skipped (${err?.message || err})`)
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
  const indexes = [...new Set(entries.map((e) => e.entryIndex))].sort((a, b) => a - b)
  if (!indexes.length) {
    onProgress?.(`autotune: no lines found for ${alien.character}`)
    return
  }
  const runs = []
  for (const i of indexes) {
    const last = runs[runs.length - 1]
    if (last && i === last.end + 1) last.end = i
    else runs.push({ start: i, end: i })
  }
  for (const r of runs) await sh.applyAutotune(artifactId, r.start, r.end)
  onProgress?.(`autotune: ${alien.character} queued — ${indexes.length} line(s) across ${runs.length} range(s)`)
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

  // Make sure both bookend scenes actually have a rendered bed — generate any
  // the coverage skipped (the outro scene usually needs this). Best-effort.
  const readyIdx = new Set(
    (Array.isArray(music.definedClips) ? music.definedClips : [])
      .filter((c) => c.status === 'ready')
      .map((c) => c.sceneIndex),
  )
  const missing = [...keep].filter((i) => !readyIdx.has(i))
  if (missing.length) {
    try {
      onProgress?.(`music: rendering bookend bed(s) for scene(s) [${missing.join(', ')}]`)
      await sh.regenerateMusicScenes(artifactId, missing, { onProgress })
    } catch (err) {
      onProgress?.(`music: bookend bed render skipped (${err?.message || err})`)
    }
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
