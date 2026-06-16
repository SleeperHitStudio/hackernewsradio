/**
 * Throwaway diagnostic: run the full Story API flow against PROD with per-stage
 * timing, to see which stage eats the 8-min performable budget. Not part of the
 * app. Usage: node prod-probe.mjs
 */
import { SleeperHit } from './server/sleeperhit.mjs'
import { fetchThread, threadToTranscript } from './server/hn.mjs'

const KEY = process.env.SLEEPERHIT_API_KEY || 'sh_303edaa9bebe5d00ea_a912ae598fab95f2d6847c7a5bdb5783dd657a2e38a188825503b4428386c7c8'
const BASE = process.env.SLEEPERHIT_API_BASE || 'https://sleeperhit.studio'
const URL = 'https://news.ycombinator.com/item?id=45249287' // 15-comment vape thread

const t0 = Date.now()
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(0)}s`
const log = (m) => console.log(`[${ts()}] ${m}`)

const sh = new SleeperHit({ baseUrl: BASE, apiKey: KEY })

const thread = await fetchThread(URL)
log(`thread: ${thread.total} comments`)

const projectId = await sh.createProject({ name: `PROBE ${thread.id}` })
log(`project ${projectId}`)

const sourceId = await sh.addTextSource(projectId, { content: threadToTranscript(thread), label: 'probe' })
await sh.pollSourceReady(projectId, sourceId, { onProgress: (m) => log(m) })
log('source ready')

const plan = await sh.createTableReadPlan(projectId, {
  title: thread.title.slice(0, 150),
  target: {
    audience: 'Podcast listeners who love internet culture',
    objective: 'Dramatize a Hacker News thread as an audio drama',
    outcome: 'The listener hears the thread as living characters',
  },
  creativeBrief: {
    projectFormat: 'audio_series',
    genre: 'comedy inferred from the thread',
    writingStyle: 'A short radio drama using real quotes from the comments.',
    pageTarget: 3,
    castNotes: 'No more than 6 archetype characters; each speaks actual quotes.',
    musicStyle: 'Light, present score.',
    sfxPolicy: 'Plenty of SFX.',
    mustKnowBeforeWriting: ['Real HN thread', 'Use real quotes', '<=6 characters'],
  },
  sourceIds: [sourceId],
  narrationPolicy: 'auto',
})
log(`plan ${plan.id} created`)
const reviewed = await sh.pollPlanForReview(plan.id, { onProgress: (m) => log(m) })
log(`plan -> ${reviewed.status}`)
if (reviewed.status === 'REQUIRES_APPROVAL') { await sh.approvePlan(plan.id); log('approved') }

const jobId = await sh.createJob(plan.id)
log(`job ${jobId}`)
try {
  const artifactId = await sh.pollJobReady(jobId, { onProgress: (m) => log(m) })
  log(`ARTIFACT ${artifactId} — performable!`)
  const audioUrl = await sh.finalizeAudio(artifactId, { onProgress: (m) => log(m) })
  log(`MP3: ${audioUrl}`)
} catch (err) {
  log(`JOB FAILED: ${err.message}`)
}
