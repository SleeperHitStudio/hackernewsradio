/**
 * The generation pipeline as a Cloudflare Workflow — a durable port of
 * server/generate.mjs runPipeline. Long polls are chunked into bounded
 * step.do calls (a chunk of GET polls is idempotent and safe to replay);
 * credit-reserving POSTs get DETERMINISTIC idempotency keys so a step retry
 * can never double-spend.
 */
import { WorkflowEntrypoint } from 'cloudflare:workers'
import { SleeperHit, SleeperHitError } from './sleeperhit.mjs'
import { fetchArticle, fetchThread, threadToTranscript } from './hn.mjs'
import { classifySystemicFailure } from './failure-classification.mjs'
import { enforceSfxCanon } from './sfx-canon.mjs'
import { SHOW_MEMORY_KEY, appendMemory, buildSeriesContext, extractEpisodeMemory } from './show-memory.mjs'
import {
  AVATAR_STYLE,
  HOSTS,
  OUTPUT_BUDGET_RE,
  buildBrief,
  buildStoryJobArtifactRequests,
  hostAvatarUrl,
  hostForCharacter,
  pageTargetFor,
} from './brief.mjs'
import { patchDrama, appendProgress, getDrama, getSetting, setSetting, deleteOtherEpisodesOfThread } from './store.mjs'
import {
  STORY_JOB_POLL_CHUNKS,
  audibleMiddleSceneIndexes,
  bookendSceneIndexes,
  ensureAutotuneClickReady,
  ensureRequestedVoiceModsReady,
  hasInFlightMusicClips,
  inspectBookends,
  isDefinitiveStoryJobResumeRejection,
  isSalvagedStoryJobOutcome,
  isSpokenTakeThin,
  isTerminalStoryJobFailureOutcome,
  minimumSpokenWords,
  pollInWorkflowChunks,
  postProductionIdempotencyScope,
  resumedStoryJobArtifactId,
  runHardStep,
  runWorkflowStepOnce,
  shouldRollFailedStoryJob,
  shouldReuseResumedStoryJob,
  storyJobIdempotencyScope,
  storyJobPollOutcome,
  terminalStoryJobFallbackPlanId,
} from './reliability.mjs'

export class HnrPipeline extends WorkflowEntrypoint {
  async run(event, step) {
    const { dramaId, url, staggerSec = 0 } = event.payload
    const env = this.env
    const db = env.DB
    const sh = new SleeperHit({ baseUrl: env.SLEEPERHIT_API_BASE, apiKey: env.SLEEPERHIT_API_KEY })
    const progressRunId = event.instanceId
      || event.payload.repairRunId
      || event.payload.resumeRunId
      || event.payload.recoveryRunId
      || dramaId
    const note = (message, eventKey = message) =>
      appendProgress(db, dramaId, message, { runId: progressRunId, eventKey }).catch(() => {})
    const isRepair = Boolean(event.payload.repairArtifactId)
    const isResume = Boolean(event.payload.resumeArtifactId)
    const resumePlanId = event.payload.resumePlanId ?? null
    const resumeJobId = event.payload.resumeJobId ?? null
    const isUpstreamRecovery = Boolean(resumePlanId || resumeJobId)
    const recoveryOriginal = (isRepair || isResume || isUpstreamRecovery)
      ? await getDrama(db, dramaId)
      : null

    try {
      if (staggerSec > 0) await step.sleep('stagger', `${staggerSec} seconds`)

      const thread = await runWorkflowStepOnce(step, 'fetch thread', () => fetchThread(url))
      // Best-effort, and its own step so a slow publisher cannot take the
      // episode down with it: fetchArticle never throws, and an episode without
      // the article is still an episode — just a shallower one.
      thread.article = await runWorkflowStepOnce(step, 'fetch source article', async () => {
        if (!thread.articleUrl) return null
        const article = await fetchArticle(thread.articleUrl)
        if (!article) console.log(`[hnr] source article unavailable for ${thread.articleUrl}`)
        return article
      })
      // A published episode remains playable while a repair is in flight. Its
      // replacement media is promoted only after finalize succeeds.
      if (!(recoveryOriginal?.status === 'ready' && recoveryOriginal?.audioUrl)) {
        await patchDrama(db, dramaId, {
          status: 'running',
          error: null,
          failureClass: null,
          failureCode: null,
          failureMessage: null,
        })
      }

      // ── Source ─────────────────────────────────────────────────────────────
      const projectId = env.HNRADIO_PROJECT_ID

      // Resume/repair mode keeps the existing performance but always re-runs
      // mandatory post-production under a fresh operation scope. That prevents
      // a resume after an autotune/music failure from publishing clean audio.
      let artifactId = event.payload.resumeArtifactId ?? event.payload.repairArtifactId ?? null
      if (artifactId) {
        await patchDrama(db, dramaId, { artifactId })
        await note(event.payload.repairArtifactId
          ? 'Repairing post-production on the existing performance…'
          : 'Resuming — re-checking autotune and jazz bookends on the existing performance…')
      }

      if (!artifactId) {

      let sourceId = null
      if (!isUpstreamRecovery) {
        // Project cast canon: pinned host portraits + the show's portrait style,
        // inherited by every episode at creation (the platform seeds them before
        // generation, so hosts are never re-rendered). One GET, PATCH only when
        // out of date; tolerant of platform builds that predate the endpoint —
        // the per-episode 'pin headshots' step stays as the fallback.
        await runWorkflowStepOnce(step, 'ensure cast canon', async () => {
          try {
            const canon = await sh.getCastCanon(projectId)
            const have = new Map((canon?.content?.characters ?? []).map((c) => [c.name.toUpperCase(), c.avatarUrl]))
            const current = canon?.content?.avatarStyle === AVATAR_STYLE
              && HOSTS.every((h) => have.get(h.name) === hostAvatarUrl(h.name))
            if (!current) {
              await sh.patchCastCanon(projectId, {
                avatarStyle: AVATAR_STYLE,
                characters: HOSTS.map((h) => ({ name: h.name, avatarUrl: hostAvatarUrl(h.name) })),
              })
              await note('Refreshed the show cast canon (portraits + style)')
            }
          } catch { /* endpoint not deployed yet — pin step covers the hosts */ }
        })

        await note('Adding this episode to HNRadio…')
        sourceId = await this.hardStep(step, 'add source', () =>
          sh.addTextSource(projectId, {
            content: threadToTranscript(thread),
            label: `HN thread ${thread.id}`,
            idempotencyKey: `${dramaId}-source`,
          }), { replaySafe: true })
        await this.pollChunked(step, 'source', 8, async () => {
          const res = await sh.request(`/story-projects/${projectId}/sources/${sourceId}`)
          const status = res.source?.status
          if (status === 'READY' || status === undefined) return 'done'
          if (status === 'FAILED') throw new SleeperHitError(
            res.source?.failureMessage || 'Source extraction failed.',
            { code: res.source?.failureCode },
          )
          return 'pending'
        })
      } else {
        await note(resumeJobId
          ? `Resuming existing Sleeper Hit job ${resumeJobId}…`
          : `Resuming existing Sleeper Hit plan ${resumePlanId}…`)
      }

      // Preassign the complete recurring cast before Sleeper starts the table
      // read. First-run/incomplete settings deliberately omit voiceMap so the
      // existing AI assignment + post-artifact pinHostVoices bootstrap remains
      // intact. Upstream recovery reads this setting only when a resumed plan
      // still needs its first job; it never creates another source.
      const pinnedVoices = await runWorkflowStepOnce(
        step,
        'load pinned voices',
        () => getSetting(db, 'pinnedVoices'),
      )

      // ── Plan + perform with the adaptive page target ───────────────────────
      let pageTarget = pageTargetFor(thread)
      // The brief allows one optional guest commenter, whose voice can never be
      // preassigned. Once a blueprint casts one, stop sending the pinned host
      // map (Sleeper requires it to cover EVERY speaking character) and rely on
      // automatic casting + the pinHostVoices() repair that follows the artifact.
      let includePinnedCast = true
      const pollPlanStatus = (label, planId) =>
        this.pollChunked(step, label, 25, async () => {
          const res = await sh.request(`/story-plans/${planId}`)
          const status = res.plan?.status
          if (status === 'REQUIRES_APPROVAL' || status === 'APPROVED' || status === 'READY') return status
          if (status === 'FAILED' || status === 'REJECTED') {
            throw new SleeperHitError(res.plan?.failureMessage || 'Plan generation failed.', {
              code: res.plan?.failureCode,
            })
          }
          return 'pending'
        })
      const adoptSalvagedArtifact = async (jobId, outcome) => {
        await note(
          `The table read is finished; only its planned soundtrack failed (${outcome.message}) — `
          + 'continuing with the banked jazz bookends.',
          `music-only-salvage:${jobId}`,
        )
        return outcome.artifactId
      }
      const pollJobArtifact = async (label, jobId) => {
        const outcome = await this.pollChunked(step, label, STORY_JOB_POLL_CHUNKS, async () => {
          const res = await sh.request(`/story-jobs/${jobId}`)
          return storyJobPollOutcome(res.job)
        })
        if (isSalvagedStoryJobOutcome(outcome)) return adoptSalvagedArtifact(jobId, outcome)
        if (!isTerminalStoryJobFailureOutcome(outcome)) return outcome
        const error = new SleeperHitError(outcome.message, { code: outcome.code })
        error.terminalStoryJobFailure = true
        throw error
      }
      const approvePlanForNightly = async (label, planId, status) => {
        if (status !== 'REQUIRES_APPROVAL') return
        await note('Approving the blueprint…')
        await this.hardStep(step, label, () =>
          sh.request(`/story-plans/${planId}/approve`, {
            method: 'POST',
            idempotencyKey: `${dramaId}-approve-${planId}`,
            // The nightly pipeline runs with the operator's standing approval;
            // Sleeper requires the confirmation flag explicitly.
            body: { userConfirmed: true },
          }), { replaySafe: true })
      }

      let pendingResumePlanId = resumePlanId
      if (resumeJobId) {
        try {
          const resumeResponse = await this.hardStep(step, `resume job ${resumeJobId}`, () =>
            sh.resumeJob(
              resumeJobId,
              `${event.payload.recoveryRunId || dramaId}-resume-job-${resumeJobId}`,
            ), { replaySafe: true })
          await patchDrama(db, dramaId, { jobId: resumeJobId })
          const completedArtifactId = resumedStoryJobArtifactId(resumeResponse)
          if (completedArtifactId) {
            await note(
              `Sleeper Hit reports job ${resumeJobId} already complete — adopting its performance.`,
              `resume-already-complete:${resumeJobId}`,
            )
            artifactId = completedArtifactId
          } else {
            artifactId = await pollJobArtifact(`resumed job ${resumeJobId}`, resumeJobId)
          }
        } catch (error) {
          pendingResumePlanId = terminalStoryJobFallbackPlanId(error, recoveryOriginal?.planId)
          if (!pendingResumePlanId) throw error
          await note(
            `The resumed Sleeper Hit job is terminal — rolling a fresh take from plan ${pendingResumePlanId}…`,
            `terminal-job-fallback:${resumeJobId}`,
          )
        }
      }
      if (!artifactId) {
        const jobScope = storyJobIdempotencyScope(dramaId, event.payload.recoveryRunId)
        for (let round = 1; artifactId === null; round++) {
          // The show's running memory. Read fresh each round so a retry after a
          // failed draft still sees what earlier episodes spent.
          const seriesContext = await runWorkflowStepOnce(step, `series memory r${round}`, async () => {
            try { return buildSeriesContext(await getSetting(db, SHOW_MEMORY_KEY)) } catch { return null }
          })
          const brief = buildBrief(thread, pageTarget, seriesContext)
          let planId = null
          if (pendingResumePlanId) {
            planId = pendingResumePlanId
            await this.hardStep(step, `resume plan ${planId}`, () =>
              sh.resumePlan(
                planId,
                `${event.payload.recoveryRunId || dramaId}-resume-plan-${planId}`,
              ), { replaySafe: true })
            await patchDrama(db, dramaId, { planId })
            const status = await pollPlanStatus(`resumed plan ${planId}`, planId)
            await approvePlanForNightly(`approve resumed plan ${planId}`, planId, status)
            pendingResumePlanId = null
          }
          for (let attempt = 1; attempt <= 4 && !planId; attempt++) {
            await note(attempt === 1
              ? `Planning the podcast at ${pageTarget} pages (cast, scenes, music, SFX)…`
              : `Re-planning (attempt ${attempt})…`)
            try {
              const plan = await this.hardStep(step, `create plan r${round}a${attempt}`, () => sh.createTableReadPlan(projectId, {
                title: brief.title,
                target: brief.target,
                creativeBrief: brief.creativeBrief,
                styleConstraints: brief.styleConstraints,
                sourceIds: [sourceId],
                narrationPolicy: 'suppress',
                idempotencyKey: `${dramaId}-plan-r${round}-a${attempt}`,
              }), { replaySafe: true })
              await patchDrama(db, dramaId, { planId: plan.id })
              const status = await pollPlanStatus(`plan r${round}a${attempt}`, plan.id)
              await approvePlanForNightly(`approve r${round}a${attempt}`, plan.id, status)
              planId = plan.id
            } catch (err) {
              if (classifySystemicFailure(err)) throw err
              if (attempt === 4) throw err
              await note(`Plan attempt ${attempt} failed (${err?.message || err}); retrying…`)
            }
          }

          await note('Performing the podcast — writing, voicing, scoring…')
          try {
            let jobId = null
            let jobRoll = 0
            for (let attempt = 1; attempt <= 3 && artifactId === null; attempt++) {
              try {
                // Resume the round's existing job on retry — a client-side poll
                // failure does NOT mean the server-side job failed, and a fresh
                // job would double-spend credits. jobRoll bumps only when we
                // DELIBERATELY abandon a job (terminal failure / thin script);
                // without it the idempotency key would hand back the corpse.
                jobId = jobId ?? await this.hardStep(step, `create job r${round}j${jobRoll}`, async () => {
                  const artifactRequests = buildStoryJobArtifactRequests({
                    existingArtifactId: artifactId,
                    pinnedVoices: includePinnedCast ? pinnedVoices : null,
                    narrationPolicy: 'suppress',
                    notes: brief.performanceNotes,
                  })
                  if (!artifactRequests) throw new Error('Existing artifacts must use resume/repair, not createJob.')
                  return sh.request('/story-jobs', {
                    method: 'POST',
                    idempotencyKey: `${jobScope}-job-r${round}-j${jobRoll}`,
                    body: {
                      storyPlanId: planId,
                      artifactRequests,
                    },
                  }).then((r) => r.job.id)
                }, { replaySafe: true })
                await patchDrama(db, dramaId, { jobId })
                artifactId = await pollJobArtifact(`job r${round}a${attempt}`, jobId)

                // Length gate: the writer is high-variance — some rolls produce
                // 100+ dialogue entries (~9 min spoken), others 40 (~4 min) from
                // the SAME brief. The audio is always fine; thin episodes were
                // under-WRITTEN, not truncated. Measure actual SPOKEN words and
                // reroll a fresh performance when far under the page target
                // A valid fast panel take lands around 56-60 spoken words/page;
                // reject only below 55/page so we stop discarding good audio.
                const spokenWords = await runWorkflowStepOnce(step, `measure r${round}a${attempt}`, async () => {
                  const res = await sh.request(`/artifacts/${artifactId}/script?limit=500`)
                  const entries = res.script?.selection?.entries ?? res.script?.entries ?? []
                  return entries.reduce(
                    (sum, e) => sum + String(e.text ?? '').trim().split(/\s+/).filter(Boolean).length, 0)
                }).catch(() => null)
                const minSpoken = minimumSpokenWords(pageTarget)
                if (spokenWords !== null && isSpokenTakeThin(spokenWords, pageTarget)) {
                  if (attempt < 3) {
                    await note(`Script came in thin (${spokenWords} spoken words, want ${minSpoken}+) — rolling a fresh take…`)
                    jobId = null
                    jobRoll++
                    artifactId = null
                    continue
                  }
                  await note(`Accepting a thin take (${spokenWords} spoken words) — retries exhausted`)
                }
              } catch (err) {
                const msg = err?.message || String(err)
                if (classifySystemicFailure(err)) throw err
                if (includePinnedCast && attempt < 3 && /voiceMap is missing/i.test(msg)) {
                  includePinnedCast = false
                  jobId = null
                  jobRoll++
                  await note('The blueprint cast a guest commenter — recasting with automatic voice assignment…')
                  continue
                }
                const overBudget = OUTPUT_BUDGET_RE.test(msg)
                const transient = !/time budget|timed out/i.test(msg)
                if (attempt === 3 || !transient || (overBudget && attempt >= 2)) throw err
                // Ask Sleeper Hit to recover a terminal job from its own durable
                // checkpoint before creating another paid performance. This is
                // especially important for a late Lyria/finalize failure: the
                // screenplay, cast, and successful clips already exist.
                if (shouldRollFailedStoryJob(err) && jobId) {
                  const failedJobId = jobId
                  const resumeOutcome = await this.hardStep(
                    step,
                    `resume failed job r${round}a${attempt}`,
                    async () => {
                      try {
                        return {
                          kind: 'response',
                          response: await sh.resumeJob(
                            failedJobId,
                            `${jobScope}-resume-job-${failedJobId}-a${attempt}`,
                          ),
                        }
                      } catch (resumeError) {
                        if (isDefinitiveStoryJobResumeRejection(resumeError)) {
                          return {
                            kind: 'rejected',
                            message: resumeError?.message || String(resumeError),
                          }
                        }
                        // Ambiguous delivery failures must stop this run. The
                        // resume may have landed, so a fresh job is unsafe.
                        throw resumeError
                      }
                    },
                    { replaySafe: true },
                  )
                  const completedArtifactId = resumeOutcome.kind === 'response'
                    ? resumedStoryJobArtifactId(resumeOutcome.response)
                    : null
                  const reusable = resumeOutcome.kind === 'response'
                    && shouldReuseResumedStoryJob(resumeOutcome.response)
                  if (completedArtifactId) {
                    // The read survived whatever killed the job (normally the
                    // planned soundtrack). Take it instead of polling an hour
                    // for a status transition that has already happened.
                    await note(
                      `Sleeper Hit reports job ${failedJobId} already complete — adopting its performance.`,
                      `resume-already-complete:${failedJobId}:a${attempt}`,
                    )
                    artifactId = completedArtifactId
                    continue
                  }
                  if (reusable) {
                    await note(
                      `Sleeper Hit resumed job ${failedJobId} from its durable checkpoint — keeping the same performance…`,
                      `story-job-resumed:${failedJobId}:a${attempt}`,
                    )
                  } else {
                    jobId = null
                    jobRoll++
                    await note(
                      `Sleeper Hit could not resume job ${failedJobId} (${resumeOutcome.message || 'job remained terminal'}) — rolling a fresh take…`,
                      `story-job-resume-rejected:${failedJobId}:a${attempt}`,
                    )
                  }
                }
                await note(`Performance attempt ${attempt} failed (${msg}); retrying…`)
              }
            }
          } catch (err) {
            const msg = err?.message || String(err)
            if (!isUpstreamRecovery && round < 3 && pageTarget > 4 && OUTPUT_BUDGET_RE.test(msg)) {
              pageTarget = Math.max(4, pageTarget - 3)
              await note(`Script blew the writer's output budget — re-planning tighter at ${pageTarget} pages…`)
              continue
            }
            throw err
          }
        }
      }
      await patchDrama(db, dramaId, { artifactId })

      } // end generation path

      // ── Post-production ────────────────────────────────────────────────────
      // Recovery gets a fresh operation scope so it can replace a previously
      // failed keyed render, while retries of this same Workflow stay safe.
      const recoveryRunId = event.payload.repairRunId
        || event.payload.resumeRunId
        || event.payload.recoveryRunId
      const postProductionScope = postProductionIdempotencyScope(dramaId, recoveryRunId)
      await step.sleep('post-prod break 1', '2 seconds')
      await runWorkflowStepOnce(step, 'pin voices', async () => {
        try { await this.pinHostVoices(db, sh, dramaId, artifactId) } catch (err) {
          await note(`Voice pinning skipped (${err?.message || err})`)
        }
      })
      await step.sleep('post-prod break 2', '2 seconds')
      await this.autotuneAlien(step, db, sh, dramaId, artifactId, note, postProductionScope)
      await step.sleep('post-prod break 2b', '2 seconds')
      await runWorkflowStepOnce(step, 'enforce sfx whitelist', async () => {
        // The show has ELEVEN sounds and the model does not get to add a
        // twelfth. It may still choose WHERE a cue lands; the sound itself is
        // rewritten to a banked asset or the cue is switched off. Rewriting to
        // the canonical prompt reuses that asset instead of rendering new audio,
        // exactly the way the jazz theme is reused. See worker/sfx-canon.mjs for
        // why: 555 effects across 362 labels, some of them drums and horns the
        // Series Bible bans outright.
        try {
          const summary = await enforceSfxCanon(sh, artifactId)
          if (summary.disabled > 0) {
            await note(`sfx: kept ${summary.kept} whitelisted cue(s), silenced ${summary.disabled} off-list`)
          }
        } catch (err) {
          // A failure here means the episode keeps whatever the model authored,
          // which is the pre-whitelist behaviour — degraded, never fatal.
          console.log(`[hnr] sfx whitelist enforcement skipped: ${err?.message || err}`)
        }
      })
      await runWorkflowStepOnce(step, 'record show memory', async () => {
        // What this episode actually spent, so the next one reaches elsewhere in
        // each character's range instead of defaulting to the same few bits.
        // Read from the FINISHED script rather than the brief: what was asked
        // for and what got written are different things, and only the second
        // one is the show's history.
        try {
          const entries = await sh.getScriptEntries(artifactId)
          const script = entries.map((e) => `${e.character}: ${e.text}`).join('\n')
          if (!script.trim()) return
          const drama = await getDrama(db, dramaId)
          const episode = extractEpisodeMemory(script, { hnId: drama?.hnId, title: drama?.title })
          await setSetting(db, SHOW_MEMORY_KEY, appendMemory(await getSetting(db, SHOW_MEMORY_KEY), episode))
          if (episode.violations.length > 0) {
            // A retired reference came back. Worth seeing in the episode log
            // rather than discovering it in the audio months later.
            await note(`canon: retired reference used — ${episode.violations.join(', ')}`)
          }
        } catch (err) {
          // Memory is an improvement to the NEXT episode, never a reason to
          // fail this one.
          console.log(`[hnr] show memory skipped: ${err?.message || err}`)
        }
      })
      await step.sleep('post-prod break 3', '2 seconds')
      await runWorkflowStepOnce(step, 'pin headshots', async () => {
        try {
          await sh.updateCast(artifactId, HOSTS.map((h) => ({
            character: h.name,
            avatarUrl: `https://hnradio.net/avatars/${h.name.toLowerCase()}.png`,
          })))
        } catch { /* older API */ }
      })
      await step.sleep('post-prod break 4', '2 seconds')
      await this.shapeMusic(step, db, sh, dramaId, artifactId, note, postProductionScope)

      // ── Finalize ───────────────────────────────────────────────────────────
      await note('Mixing the durable MP3 (voices + music + SFX)…')
      await step.sleep('pre-finalize break', '2 seconds')
      const first = await this.hardStep(step, 'finalize', () =>
        sh.request(`/artifacts/${artifactId}/finalize`, {
          method: 'POST',
          idempotencyKey: recoveryRunId
            ? `${dramaId}-finalize-recovery-${recoveryRunId}`
            : `${dramaId}-finalize`,
          body: { mode: 'audio' },
        }), { replaySafe: true })
      let audioUrl = first.finalize?.recordingUrl ?? null
      if (!audioUrl) {
        audioUrl = await this.pollChunked(step, 'finalize', 25, async () => {
          const res = await sh.request(`/artifacts/${artifactId}`)
          const audio = res.artifact?.manifest?.audio
          if (audio?.finalize?.status === 'failed') throw new Error(audio.finalize.error || 'Audio render failed.')
          if (audio?.recordingUrl && !['rendering', 'queued'].includes(audio?.finalize?.status)) return audio.recordingUrl
          return 'pending'
        })
      }

      await patchDrama(db, dramaId, {
        status: 'ready',
        audioUrl,
        error: null,
        failureClass: null,
        failureCode: null,
        failureMessage: null,
      })
      await note('Done — your podcast is ready.')

      await step.sleep('post-ready break', '2 seconds')
      await runWorkflowStepOnce(step, 'replace + log', async () => {
        try {
          const removed = await deleteOtherEpisodesOfThread(db, thread.id, 'podcast', dramaId)
          if (removed) await note(`Replaced ${removed} older episode(s) of this thread.`)
        } catch { /* best-effort */ }
        try { await this.logEpisodeInBible(sh, projectId, thread) } catch (err) {
          await note(`Series Bible episode log skipped (${err?.message || err})`)
        }
      })
      await step.sleep('pre-publish budget break', '6 minutes')
      const repairPublicationRequired = Boolean(event.payload.repairArtifactId) && !event.payload.skipPublish
      try {
        if (event.payload.skipPublish) return
        await this.hardStep(step, 'publish podcast feed', async () => {
          const seriesId = await getSetting(db, 'publishingSeriesId')
          if (seriesId) {
            const repairRun = event.payload.repairArtifactId || event.payload.repairRunId
            const refreshedReleaseId = repairRun
              ? await sh.refreshPublishedEpisodeMedia(seriesId, artifactId, {
                  idempotencyKey: `${dramaId}-refresh-media-${event.payload.repairRunId || 'repair'}`,
                })
              : null
            if (refreshedReleaseId) {
              await note(`Refreshed repaired media on published release ${refreshedReleaseId}.`)
            } else if (repairRun) {
              throw new Error(`No published release exists for repaired artifact ${artifactId}; refusing to create a duplicate.`)
            } else {
              await sh.publishEpisode(seriesId, {
                title: thread.title,
                descriptionDirection: 'Write one pithy sentence, 20-40 words, that sells this specific episode. Be irreverent, playful, and sharp, but use no profanity. Lead with the transcript’s actual tension, argument, or absurdity. Avoid host roll calls, generic show boilerplate, and phrases like “the hosts discuss” or “this episode explores.”',
                artifactId,
                seasonNumber: 1,
                idempotencyKeyPrefix: `${dramaId}-publish`,
              })
              await note('Published to the HNR podcast feed.')
            }
          } else if (repairPublicationRequired) {
            throw new Error('Repair publication requires the publishingSeriesId setting.')
          }
        }, { replaySafe: true })
      } catch (err) {
        if (repairPublicationRequired) throw err
        await note(`Podcast publish skipped (${err?.message || err})`)
      }
    } catch (err) {
      const message = err?.message || String(err)
      const failureClass = classifySystemicFailure(err)
      const failure = {
        error: message,
        failureClass,
        failureCode: err?.code || null,
        failureMessage: message,
      }
      if ((isRepair || isResume) && recoveryOriginal?.status === 'ready' && recoveryOriginal?.audioUrl) {
        // Do not take the currently published/playable episode offline merely
        // because replacement post-production or feed refresh failed.
        await patchDrama(db, dramaId, {
          ...failure,
          status: 'ready',
          error: `Repair failed: ${message}`,
        })
      } else {
        await patchDrama(db, dramaId, { ...failure, status: 'failed' })
      }
      await note(`Failed: ${err?.message || err}`)
      throw err
    }
  }

  /** Retry transient Workflow/DO failures only when the caller marks the work
   *  replay-safe. Every mutating caller uses deterministic Story API keys, so a
   *  reset after an accepted request cannot duplicate paid/non-idempotent work. */
  async hardStep(step, label, fn, options) {
    return runHardStep(step, label, fn, options)
  }

  /** One cheap status probe per engine invocation, with LONG durable sleeps
   *  between probes — short sleeps coalesce into a single invocation and the
   *  accumulated fetches blow Workers' per-invocation subrequest budget
   *  (observed twice in production). */
  async pollChunked(step, label, maxChunks, chunk) {
    return pollInWorkflowChunks(step, label, maxChunks, chunk)
  }

  async pinHostVoices(db, sh, dramaId, artifactId) {
    const cast = await sh.getCast(artifactId)
    const pinned = (await getSetting(db, 'pinnedVoices')) || {}
    const updates = []
    let adopted = 0
    for (const entry of cast) {
      const host = hostForCharacter(entry.character)
      if (!host) continue
      const want = pinned[host.name]
      if (!want?.voiceId) {
        pinned[host.name] = {
          voiceId: entry.voiceId, voiceName: entry.voiceName,
          ...(entry.gender ? { gender: entry.gender } : {}),
          ...(entry.provider ? { provider: entry.provider } : {}),
        }
        adopted++
      } else if (want.voiceId !== entry.voiceId) {
        updates.push({ character: entry.character, ...want })
      }
    }
    if (adopted) await setSetting(db, 'pinnedVoices', pinned)
    if (updates.length) await sh.updateCast(artifactId, updates)
  }

  async autotuneAlien(step, db, sh, dramaId, artifactId, note, idempotencyScope = dramaId) {
    const cast = await this.hardStep(step, 'autotune cast', () => sh.getCast(artifactId), { replaySafe: true })
    const alien = cast.find((c) => hostForCharacter(c.character)?.alien)
    if (!alien) return
    const entries = await this.hardStep(
      step,
      'autotune script',
      () => sh.getCharacterEntries(artifactId, alien.character),
      { replaySafe: true }
    )
    const marked = entries.filter((e) => /dial/i.test(e.parenthetical || ''))
    const indexes = [...new Set(marked.map((e) => e.entryIndex))].sort((a, b) => a - b)
    if (!indexes.length) {
      await note(`autotune: ${alien.character} kept the dial off this episode`)
      return
    }
    const runs = []
    for (const i of indexes) {
      const last = runs[runs.length - 1]
      if (last && i === last.end + 1) last.end = i
      else runs.push({ start: i, end: i })
    }
    let sfxCues = await this.hardStep(
      step,
      'autotune sfx state',
      () => sh.listSfxCues(artifactId),
      { replaySafe: true }
    )
    for (const [index, range] of runs.entries()) {
      const { cue } = await ensureAutotuneClickReady({
        cues: sfxCues,
        entryIndex: range.start,
        addCue: (fields) => this.hardStep(
          step,
          `autotune click add ${index}`,
          () => sh.addSfxCue(artifactId, {
            ...fields,
            idempotencyKey: `${idempotencyScope}-autotune-click-${range.start}-add`,
          }),
          { replaySafe: true }
        ),
        updateCue: (cueId, fields) => this.hardStep(
          step,
          `autotune click regenerate ${index}`,
          () => sh.updateSfxCue(artifactId, cueId, fields, {
            idempotencyKey: `${idempotencyScope}-autotune-click-${range.start}-update`,
          }),
          { replaySafe: true }
        ),
      })
      sfxCues = [
        ...sfxCues.filter((candidate) => candidate?.id !== cue.id
          && Number(candidate?.entryIndex) !== range.start),
        cue,
      ]
    }

    const poll = (attempt) => this.pollChunked(step, `autotune render a${attempt}`, 24, async () => {
      const summary = await sh.getVoiceModificationSummary(artifactId, runs)
      if (summary.ready === runs.length) return summary
      // On the first pass, an all-terminal result exposes the failed ranges so
      // they can be retried. After that one retry, keep polling until READY:
      // the old failed manifest row can remain newest briefly while the queued
      // replacement appears, and must not be mistaken for a second failure.
      if (attempt === 1 && summary.pending === 0) return summary
      return 'pending'
    })
    await ensureRequestedVoiceModsReady({
      requestedRanges: runs,
      inspect: () => this.hardStep(
        step,
        'autotune existing ranges',
        () => sh.getVoiceModificationSummary(artifactId, runs),
        { replaySafe: true }
      ),
      enqueueMissing: async (missingRanges) => {
        for (const range of missingRanges) {
          await this.hardStep(
            step,
            `autotune enqueue missing ${range.start}-${range.end}`,
            () => sh.applyAutotune(artifactId, range.start, range.end, undefined, {
              // Stable across generation/resume/repair Workflows. Concurrent
              // recovery scopes that both observe a missing range therefore
              // converge on the same initial operation instead of stacking.
              idempotencyKey: `${artifactId}-autotune-${range.start}-${range.end}-initial`,
            }),
            { replaySafe: true }
          )
        }
      },
      poll,
      retryFailed: async (failedRanges) => {
        await this.hardStep(
          step,
          'autotune retry failed',
          () => sh.retryFailedVoiceMods(artifactId, {
            ranges: failedRanges,
            idempotencyKeyPrefix: `${idempotencyScope}-autotune-retry1`,
          }),
          { replaySafe: true }
        )
      },
    })
    await note(`autotune: ${alien.character} turned the dial — ${indexes.length} line(s) across ${runs.length} range(s)`)
  }

  async shapeMusic(step, db, sh, dramaId, artifactId, note, idempotencyScope = dramaId) {
    const initial = await this.hardStep(step, 'music state', () => sh.getMusic(artifactId), { replaySafe: true })
    if (initial?.musicMode !== 'defined_clips') {
      throw new Error(`Sleeper music mode ${initial?.musicMode || 'missing'} cannot guarantee jazz bookends.`)
    }

    // Let baseline coverage writes stop before replacing them. Unlike the old
    // best-effort path, a settle failure is fatal because a late platform write
    // can otherwise erase a required bookend after verification.
    await this.pollChunked(step, 'music settle', 12, async () => {
      const music = await sh.getMusic(artifactId)
      if (music?.musicMode !== 'defined_clips') throw new Error('Sleeper changed music mode while shaping bookends.')
      return hasInFlightMusicClips(music) ? 'pending' : music
    })

    // The settle probes may share one warm Durable Object invocation. Hibernate
    // before write-heavy theme installation for a fresh subrequest budget. A
    // second probe is mandatory: baseline renders can be momentarily quiet
    // between queued clips, then resume while this Workflow is sleeping.
    await step.sleep('music write budget break', '6 minutes')
    const authoritative = await this.pollChunked(step, 'music settle after break', 8, async () => {
      const music = await sh.getMusic(artifactId)
      if (music?.musicMode !== 'defined_clips') throw new Error('Sleeper changed music mode while shaping bookends.')
      return hasInFlightMusicClips(music) ? 'pending' : music
    })
    const { totalScenes, introIndex, outroIndex } = bookendSceneIndexes(authoritative.totalScenes)

    const assertSameSceneCount = (music) => {
      const current = bookendSceneIndexes(music?.totalScenes)
      if (current.totalScenes !== totalScenes) {
        throw new Error(`Sleeper totalScenes changed from ${totalScenes} to ${current.totalScenes}.`)
      }
    }

    const banked = await getSetting(db, 'jazzTheme')
    let installed = false
    let expectedUrls = null
    if (banked?.intro?.soundUrl && banked?.outro?.soundUrl) {
      await note(`music: installing jazz bookends at scenes ${introIndex} + ${outroIndex}`)
      try {
        await this.hardStep(step, 'install theme intro', () => sh.setDefinedClip(artifactId, introIndex, {
          soundUrl: banked.intro.soundUrl,
          ...(banked.intro.durationMs ? { durationMs: banked.intro.durationMs } : {}),
          playMode: 'once',
        }, { idempotencyKey: `${idempotencyScope}-bookend-intro` }), { replaySafe: true })
        await this.hardStep(step, 'install theme outro', () => sh.setDefinedClip(artifactId, outroIndex, {
          soundUrl: banked.outro.soundUrl,
          ...(banked.outro.durationMs ? { durationMs: banked.outro.durationMs } : {}),
          playMode: 'once',
          anchor: 'end',
        }, { idempotencyKey: `${idempotencyScope}-bookend-outro` }), { replaySafe: true })
        await this.pollChunked(step, 'verify banked theme', 8, async () => {
          const music = await sh.getMusic(artifactId)
          assertSameSceneCount(music)
          const status = inspectBookends(music, {
            introIndex,
            outroIndex,
            expectedUrls: { intro: banked.intro.soundUrl, outro: banked.outro.soundUrl },
          })
          if (status.failed) throw new Error('Banked jazz bookend installation failed.')
          return status.ready ? music : 'pending'
        })
        installed = true
        expectedUrls = { intro: banked.intro.soundUrl, outro: banked.outro.soundUrl }
      } catch (err) {
        await note(`music: banked theme unavailable (${err?.message || err}); rendering required bookends`)
      }
    }

    if (!installed) {
      await this.hardStep(step, 'jazz directive', () => sh.setMusicDirective(artifactId, {
        prompt:
          'The show theme: sleazy late-night jazz — walking upright bass, brushed drums, smoky saxophone, a touch ' +
          'of Rhodes; slow, too cool for the content, played straight.',
      }, { idempotencyKey: `${idempotencyScope}-jazz-directive` }), { replaySafe: true })
      await note(`music: rendering required jazz bookends at scenes ${introIndex} + ${outroIndex}`)
      await this.hardStep(step, 'render beds', () => sh.request(`/artifacts/${artifactId}/music`, {
        method: 'POST',
        idempotencyKey: `${idempotencyScope}-beds`,
        body: { regenerateScenes: [introIndex, outroIndex] },
      }), { replaySafe: true })
      const rendered = await this.pollChunked(step, 'beds', 16, async () => {
        const music = await sh.getMusic(artifactId)
        assertSameSceneCount(music)
        const status = inspectBookends(music, { introIndex, outroIndex, checkAnchor: false })
        if (status.failed) throw new Error('Bookend music render failed.')
        return status.ready ? music : 'pending'
      })
      const renderedOutro = inspectBookends(rendered, {
        introIndex,
        outroIndex,
        checkAnchor: false,
      }).outro
      await this.hardStep(
        step,
        'anchor outro',
        () => sh.setDefinedClip(artifactId, outroIndex, {
          ...(renderedOutro?.soundUrl ? { soundUrl: renderedOutro.soundUrl } : {}),
          ...(renderedOutro?.durationMs ? { durationMs: renderedOutro.durationMs } : {}),
          playMode: renderedOutro?.playMode || 'once',
          anchor: 'end',
        }, {
          idempotencyKey: `${idempotencyScope}-bookend-outro-anchor`,
        }),
        { replaySafe: true }
      )

      // Self-bank this render as THE theme for future episodes. Require the API
      // to echo the end anchor before accepting or banking it.
      const state = await this.pollChunked(step, 'bank check', 8, async () => {
        const music = await sh.getMusic(artifactId)
        assertSameSceneCount(music)
        const status = inspectBookends(music, { introIndex, outroIndex })
        if (status.failed) throw new Error('Rendered jazz bookend failed while anchoring the outro.')
        return status.ready ? music : 'pending'
      })
      const status = inspectBookends(state, { introIndex, outroIndex })
      if (status.ready && status.intro?.soundUrl && status.outro?.soundUrl) {
        expectedUrls = { intro: status.intro.soundUrl, outro: status.outro.soundUrl }
        await setSetting(db, 'jazzTheme', {
          intro: { soundUrl: status.intro.soundUrl, durationMs: status.intro.durationMs ?? null },
          outro: { soundUrl: status.outro.soundUrl, durationMs: status.outro.durationMs ?? null },
          bankedAt: new Date().toISOString(),
        })
        await note('music: jazz theme BANKED — future episodes reuse these exact recordings')
      }
    }

    if (!expectedUrls) {
      throw new Error('Jazz bookend audio URLs could not be verified.')
    }

    // Require two clean snapshots separated by a durable sleep. If a late
    // baseline write re-materializes a middle bed, mute it and restart the
    // stability count. The expected URLs and explicit end anchor are checked on
    // every pass, so a late overwrite cannot masquerade as a valid bookend.
    let cleanPasses = 0
    for (let pass = 1; pass <= 6 && cleanPasses < 2; pass++) {
      const state = await this.pollChunked(step, `verify jazz state p${pass}`, 8, async () => {
        const music = await sh.getMusic(artifactId)
        assertSameSceneCount(music)
        if (hasInFlightMusicClips(music)) return 'pending'
        const status = inspectBookends(music, { introIndex, outroIndex, expectedUrls })
        if (status.failed) throw new Error('Required jazz bookend failed after installation.')
        return status.ready ? music : 'pending'
      })
      const offenders = audibleMiddleSceneIndexes(state, { introIndex, outroIndex })
      if (offenders.length) {
        cleanPasses = 0
        for (const sceneIndex of offenders) {
          await this.hardStep(
            step,
            `mute middle ${sceneIndex} p${pass}`,
            () => sh.setDefinedClip(artifactId, sceneIndex, { disabled: true }, {
              idempotencyKey: `${idempotencyScope}-mute-middle-${sceneIndex}`,
            }),
            { replaySafe: true }
          )
        }
      } else {
        cleanPasses++
      }
      if (cleanPasses < 2) await step.sleep(`music stability wait p${pass}`, '45 seconds')
    }
    if (cleanPasses < 2) throw new Error('Jazz bookends never reached two stable, middle-muted checks.')
    await note(`music: required jazz bookends READY at scenes ${introIndex} + ${outroIndex}`)
  }

  async logEpisodeInBible(sh, projectId, thread) {
    const doc = await sh.getSeriesBible(projectId)
    const episodes = Array.isArray(doc?.content?.episodes) ? [...doc.content.episodes] : []
    const label = `HN ${thread.id}`
    if (episodes.some((e) => e.label === label)) return
    episodes.push({
      id: crypto.randomUUID(),
      label,
      title: thread.title.slice(0, 200),
      summary: `Produced episode on the Hacker News thread "${thread.title}" (${thread.total} comments) — ${thread.url}`,
      status: 'produced',
    })
    await sh.patchSeriesBible(projectId, { content: { episodes } })
  }
}
