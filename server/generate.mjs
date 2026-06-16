/**
 * The orchestrator. One HN URL + a mode in → a finalized MP3 out, driven
 * entirely through the Sleeper Hit Story API (the same pipeline the UI/CLI/MCP
 * use). We are a thin conductor: we hand the thread to Sleeper Hit's craft
 * engine with a tight, mode-specific creative brief and let it write, cast,
 * score, and mix.
 *
 * Two modes:
 *   - drama   → an original short audio STORY, re-enacting the thread's tension
 *               as lived events, with an arc and a real ending.
 *   - podcast → a smart, engaging, dryly funny panel discussion of the thread.
 */
import { randomUUID } from 'node:crypto'
import { SleeperHit } from './sleeperhit.mjs'
import { config } from './config.mjs'
import { fetchThread, threadToTranscript } from './hn.mjs'
import { upsertDrama, patchDrama, findByHnIdAndMode } from './store.mjs'

const client = () => new SleeperHit({ baseUrl: config.apiBase, apiKey: config.apiKey })

// Podcast is the only mode. (The drama mode was deprecated — every thread
// becomes a podcast episode.)
export const MODES = ['podcast']
export function normalizeMode() {
  return 'podcast'
}

/**
 * Scale length to the size of the debate (≈1 page ≈ 1 minute). The Story API
 * gives parse + voice + creative-analysis a 16-min budget to reach performable,
 * so we can afford a fuller read — important so the story has room to actually
 * END instead of getting cut off.
 */
function pageTargetFor(commentCount) {
  return Math.max(4, Math.min(9, Math.ceil(commentCount / 18)))
}

const SHARED_MUST_KNOW = [
  'The source is a real Hacker News comment thread; the people arguing in it are your raw material.',
  'Use REAL QUOTES from the comments wherever possible — keep their wording, voice, and personality.',
]

const SHARED_AUDIO = {
  musicStyle:
    'Sonic palette: modern, electronic, tech-forward — synth-driven and contemporary, never orchestral and never a ' +
    'cheerful jingle. But the MOOD is ADAPTIVE: let the actual content and emotional tenor of THIS thread set it. A ' +
    'tense, high-stakes debate wants darker, driving, more ominous synths; a playful or absurd thread wants something ' +
    'brighter and wrier; a reflective or wistful thread wants something cooler and more spacious. Read the room of the ' +
    'comments and score to it — do not default to one fixed theme. PLACEMENT: music plays ONLY at the very start (a ' +
    'short intro bed/sting under the cold open) and the very end (a closing outro). There is NO music at all under the ' +
    'middle of the show — the discussion runs clean, voices only. Think: theme in, talk with no score, theme out.',
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
    'Music ONLY at the intro and the outro — a short opening bed and a closing bed. NO music whatsoever under the ' +
    'middle dialogue. SFX should be plentiful throughout, but music is strictly bookend-only.',
  voicePreference: 'Prefer Cartesia voices for the cast; avoid leaning on a single provider.',
}

/** The podcast: a sharp panel show riffing on the thread. */
function podcastBrief(thread, pageTarget) {
  return {
    title: thread.title.slice(0, 150),
    target: {
      audience: 'Smart tech-podcast listeners who want a genuinely engaging show — not a laugh track',
      objective: 'Turn a real Hacker News thread into a sharp, engaging PODCAST episode worth listening to end-to-end',
      outcome: 'The listener is hooked the whole way, actually understands the debate, and is amused by the hosts\' dry wit',
      tone: 'smart, engaging, dryly funny, irreverent — wry and understated, never trying too hard',
    },
    creativeBrief: {
      projectFormat: 'audio_series',
      installmentLabel: thread.title.slice(0, 150),
      genre: 'smart, irreverent tech panel podcast',
      audience: 'Fans of Hacker News and tech culture',
      writingStyle:
        'A smart, engaging tech-panel PODCAST. 2–4 hosts with genuinely distinct, believable points of view read and ' +
        'react to the ACTUAL comments — they dig into what is actually interesting, disagree honestly, and find the dry ' +
        'humor in the thread without performing it. Wry, understated, curious; the wit lives in the observations and the ' +
        'timing, not in bits or punch-up. Engaging comes first — funny is the seasoning, not the meal. Avoid podcast ' +
        'tropes and clichés: no zany sound-effect comedy, no forced banter or catchphrases, no "and we\'re back", no ' +
        'trying too hard. NO narrator and NO announcer — a host opens the show themselves and goes straight in. ' +
        'Structure it like a real episode: a tight cold-open hook, the main discussion in a couple of segments, and a ' +
        'clean host sign-off that simply wraps up THIS conversation — NO fake next-episode teases, NO "like and ' +
        'subscribe", NO "see you next time", no invented show branding. Quote real comments verbatim and react to ' +
        'them by handle.',
      pageTarget,
      castNotes:
        'NO MORE THAN 6 voices, ALL of them HOSTS or guests — 2–4 recurring HOSTS who feel like real, specific people ' +
        'with their own genuine takes. Do NOT use stock archetypes or trope personas (no "the cynic", "the hype beast", ' +
        '"the greybeard") — give each host a particular, believable perspective instead. Optionally a guest voicing the ' +
        'thread\'s most notable commenter. DO NOT create a NARRATOR or ANNOUNCER — the hosts carry everything, ' +
        'including the intro and outro.',
      ...SHARED_AUDIO,
      mustKnowBeforeWriting: [
        ...SHARED_MUST_KNOW,
        'ENGAGING FIRST: the episode must be genuinely interesting and a pleasure to listen to all the way through.',
        'Be DRYLY funny — wry, understated, smart. Do NOT try too hard to be funny; let the humor come from real ' +
        'reactions and good timing, never from forced jokes, bits, or catchphrases.',
        'Stay irreverent and opinionated, but AVOID tropes, clichés, and stock podcast moves.',
        'NO narrator/announcer — a HOST opens the show in character and the hosts sign off themselves.',
        'Open cold on the hosts and END with a clean host sign-off — wrap up fully, do not trail off mid-sentence.',
        'The outro is just a genuine wrap-up of THIS discussion. Do NOT invent a next episode, tease future shows, ' +
        'ask listeners to like/subscribe/follow/rate, or use any podcast-outro CTA clichés.',
      ],
    },
    styleConstraints: SHARED_STYLE_CONSTRAINTS,
  }
}

function buildBrief(thread) {
  return podcastBrief(thread, pageTargetFor(thread.total))
}

const stamp = () => new Date().toISOString()

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

  await note(id, 'Creating project…')
  const projectId = await sh.createProject({ name: `HN ${label} — ${thread.title}`.slice(0, 120) })
  await patchDrama(id, { projectId })

  await note(id, 'Adding the thread as source…')
  const sourceId = await sh.addTextSource(projectId, {
    content: threadToTranscript(thread),
    label: `HN thread ${thread.id}`,
  })
  await sh.pollSourceReady(projectId, sourceId, { onProgress })

  // Plan generation is a structured-output LLM call and is occasionally flaky.
  // Plans don't spend credits, so re-roll a few times before giving up.
  const brief = buildBrief(thread)
  let planId = null
  for (let attempt = 1; attempt <= 4; attempt++) {
    await note(id, attempt === 1 ? `Planning the ${label} (cast, scenes, music, SFX)…` : `Re-planning (attempt ${attempt})…`)
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

  // Run the generation job. Failed jobs refund credits, so retry transient
  // failures; do NOT retry a "time budget" failure (a retry won't help).
  await note(id, `Performing the ${label} — writing, voicing, scoring…`)
  let artifactId = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const jobId = await sh.createJob(planId)
      await patchDrama(id, { jobId })
      artifactId = await sh.pollJobReady(jobId, { onProgress })
      break
    } catch (err) {
      const msg = err?.message || String(err)
      const transient = !/time budget/i.test(msg)
      if (attempt === 3 || !transient) throw err
      await note(id, `Performance attempt ${attempt} failed (${msg}); retrying…`)
    }
  }
  await patchDrama(id, { artifactId })

  await note(id, 'Mixing the durable MP3 (voices + music + SFX)…')
  const audioUrl = await sh.finalizeAudio(artifactId, { onProgress })

  await patchDrama(id, { status: 'ready', audioUrl, error: null })
  await note(id, `Done — your ${label} is ready.`)
}
