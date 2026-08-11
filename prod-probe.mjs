/**
 * Throwaway diagnostic: run the full Story API flow against PROD with per-stage
 * timing, to see which stage eats the performable budget. Not part of the app.
 * Usage: SLEEPERHIT_API_KEY=... node prod-probe.mjs
 */
import { SleeperHit } from './server/sleeperhit.mjs'
import {
  buildSourceMetadata,
  fetchThread,
  hydrateThreadArticle,
  threadToTranscript,
  verifiedSourceProgress,
} from './server/hn.mjs'

const KEY = process.env.SLEEPERHIT_API_KEY
const BASE = process.env.SLEEPERHIT_API_BASE || 'https://sleeperhit.studio'
const URL = 'https://news.ycombinator.com/item?id=45249287' // 15-comment vape thread
if (!KEY) throw new Error('Set SLEEPERHIT_API_KEY before running the production probe.')

const t0 = Date.now()
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(0)}s`
const log = (message) => console.log(`[${ts()}] ${message}`)

const sh = new SleeperHit({ baseUrl: BASE, apiKey: KEY })

const thread = await fetchThread(URL)
await hydrateThreadArticle(thread)
const sourceTranscript = threadToTranscript(thread)
const sourceMetadata = buildSourceMetadata(thread, sourceTranscript)
log(verifiedSourceProgress(thread))

const projectId = await sh.createProject({ name: `PROBE ${thread.id}` })
log(`project ${projectId}`)

const sourceId = await sh.addTextSource(projectId, {
  content: sourceTranscript,
  label: 'probe',
  metadata: sourceMetadata,
})
await sh.pollSourceReady(projectId, sourceId, { onProgress: (message) => log(message) })
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
const reviewed = await sh.pollPlanForReview(plan.id, { onProgress: (message) => log(message) })
log(`plan -> ${reviewed.status}`)
if (reviewed.status === 'REQUIRES_APPROVAL') {
  await sh.approvePlan(plan.id)
  log('approved')
}

const jobId = await sh.createJob(plan.id)
log(`job ${jobId}`)
try {
  const artifactId = await sh.pollJobReady(jobId, { onProgress: (message) => log(message) })
  log(`ARTIFACT ${artifactId} — performable!`)
  const audioUrl = await sh.finalizeAudio(artifactId, { onProgress: (message) => log(message) })
  log(`MP3: ${audioUrl}`)
} catch (error) {
  log(`JOB FAILED: ${error.message}`)
}
