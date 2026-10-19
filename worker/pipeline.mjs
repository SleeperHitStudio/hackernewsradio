/**
 * The generation pipeline as a Cloudflare Workflow — a durable port of
 * server/generate.mjs runPipeline. Long polls are chunked into bounded
 * step.do calls (a chunk of GET polls is idempotent and safe to replay);
 * credit-reserving POSTs get DETERMINISTIC idempotency keys so a step retry
 * can never double-spend.
 */
import { WorkflowEntrypoint } from 'cloudflare:workers'
import { SleeperHit, SleeperHitError } from './sleeperhit.mjs'
import {
  COMMENTER_NAMES,
  HNError,
  INDEX_LAG_REFETCH_BACKOFF_SECONDS,
  buildSourceMetadata,
  commentIndexLag,
  fetchArticle,
  fetchThread,
  sourceIdentity,
  sourceOrigin,
  threadGrewMaterially,
  threadToTranscript,
  verifiedSourceProgress,
} from './hn.mjs'
import { classifySystemicFailure } from './failure-classification.mjs'
import { pseudonymOptions } from './pseudonyms.mjs'
import { enforceSfxCanon } from './sfx-canon.mjs'
import {
  SHOW_MEMORY_KEY,
  appendMemory,
  buildSeriesContext,
  extractEpisodeMemory,
} from './show-memory.mjs'
import {
  HOSTS,
  OUTPUT_BUDGET_RE,
  buildBrief,
  buildStoryJobArtifactRequests,
  hostForCharacter,
  pageTargetFor,
} from './brief.mjs'
import { syncCastCanonFromPins } from './cast-canon.mjs'
import {
  isRefusedRead,
  publishKeyPrefix,
  publishingReadiness,
} from './readiness.mjs'
import {
  PUBLISH_BLOCKED_ALERT_KEY,
  alertOnce,
  clearAlertLatch,
} from './alerts.mjs'
import {
  appendProgress,
  claimSetting,
  deleteOtherEpisodesOfThread,
  getDrama,
  getSetting,
  isDroppedEpisode,
  listLiveEpisodesOfThread,
  patchDrama,
  setSetting,
} from './store.mjs'
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
  offCastSpeakers,
  pollInWorkflowChunks,
  postProductionIdempotencyScope,
  resumedStoryJobArtifactId,
  runHardStep,
  runWorkflowStepOnce,
  shouldRecastWithoutPinnedCast,
  shouldRollFailedStoryJob,
  shouldReuseResumedStoryJob,
  storyJobIdempotencyScope,
  storyJobPollOutcome,
  terminalStoryJobFallbackPlanId,
  capturedSource,
  isHttpRefusal,
  isInsufficientCredits,
  storyJobKey,
} from './reliability.mjs'
import {
  EPISODE_DESCRIPTION_DIRECTION,
  PLAN_APPROVAL_BODY,
  PUBLISHED_PROGRESS_MESSAGE,
  showNotesLinks,
} from './publishing.mjs'

/**
 * The Story API proves a source by EQUAL expected/fetched comment counts, and a capture can be a comment
 * short while the search index catches up ("70/71 (index lag)"). Re-fetch the thread with backoff
 * (INDEX_LAG_REFETCH_BACKOFF_SECONDS, about a minute in all, each wait a durable step.sleep and each
 * fetch the ordinary fetchThread with its own client and timeouts) and return the first whole capture.
 * One that never converges is not uploaded: it fails as `hn_thread_incomplete`, the source-lag class
 * the nightly holds for free and retries next tick, instead of a refused upload.
 */
async function convergeIndexLag(step, thread, url, note, fetchOptions) {
  let current = thread
  for (const [index, seconds] of INDEX_LAG_REFETCH_BACKOFF_SECONDS.entries()) {
    const lag = commentIndexLag(current)
    if (!lag) return current
    await note(
      `HN thread ${current.id} is ${lag.fetched}/${lag.expected} (index lag); re-fetching in ${seconds} s so the source uploads whole…`,
      `index-lag-refetch-${index + 1}`,
    )
    await step.sleep(`index lag wait ${index + 1}`, `${seconds} seconds`)
    current = await runWorkflowStepOnce(step, `refetch lagging thread ${index + 1}`, () => fetchThread(url, fetchOptions))
  }
  const lag = commentIndexLag(current)
  if (!lag) return current
  throw new HNError(
    `Hacker News thread ${current.id} is not synchronized yet: ${lag.fetched}/${lag.expected} comments after `
    + `${INDEX_LAG_REFETCH_BACKOFF_SECONDS.length} re-fetches; the source uploads only once the counts match.`,
    { code: 'hn_thread_incomplete', details: { storyId: current.id, ...lag } },
  )
}

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
    // Publish-only recovery: the MP3 already exists and only the feed step is
    // missing. No post-production, no re-finalize — those are paid, and a
    // swallowed publish error used to re-run them every hour (364 finalizes in
    // one week for episodes that were already finished).
    const isPublishOnly = Boolean(event.payload.publishOnly)
    const resumePlanId = event.payload.resumePlanId ?? null
    const resumeJobId = event.payload.resumeJobId ?? null
    const isUpstreamRecovery = Boolean(resumePlanId || resumeJobId)
    const recoveryOriginal = (isRepair || isResume || isUpstreamRecovery || isPublishOnly)
      ? await getDrama(db, dramaId)
      : null
    // The job request a 402 refused, when this run is the recovery that
    // re-sends it (see the job step).
    const pendingJob = event.payload.jobKey
      && recoveryOriginal?.pendingJob?.key === event.payload.jobKey
      && recoveryOriginal.pendingJob.body
      ? recoveryOriginal.pendingJob
      : null

    try {
      // A dropped episode never airs (store.mjs DROPPED_STATUS): whatever started this run, it makes, finalizes
      // and publishes nothing. Read outside any step, so it is re-checked on every wake of a long run.
      if (await this.episodeDropped(db, dramaId)) return 'dropped'

      if (isPublishOnly) {
        if (!recoveryOriginal?.artifactId || !recoveryOriginal?.audioUrl) {
          throw new Error(`Cannot publish ${dramaId}: the episode has no finished MP3.`)
        }
        await note('Publishing the finished episode to the HNR podcast feed…', `publish-only:${progressRunId}`)
        await this.publishToFeed(step, {
          env, db, sh, dramaId, note,
          artifactId: recoveryOriginal.artifactId,
          title: recoveryOriginal.title || 'Hacker News Radio',
          payload: event.payload,
        })
        return
      }

      // An unattended producer spends NOTHING without the series' standing
      // approval bound to its own key: no upload, no plan, no job. Revoking the
      // grant is how the owner stops the show, so it must stop the spending,
      // not just the publishing. Post-production of an existing performance
      // (resume/repair) is already paid for and is not gated here.
      if (!isRepair && !isResume) {
        await this.requireStandingApproval(step, { env, db, sh, label: 'standing approval' })
      }

      if (staggerSec > 0) await step.sleep('stagger', `${staggerSec} seconds`)

      const recoversExistingSource = isRepair || isResume || isUpstreamRecovery
      // Commenters are named only by pseudonym: the key is resolved before anything is fetched.
      const fetchOptions = recoversExistingSource ? null : pseudonymOptions(env)
      let thread = recoversExistingSource
        ? {
            id: String(recoveryOriginal?.hnId ?? ''),
            title: recoveryOriginal?.title || 'Recovered Hacker News episode',
            url: recoveryOriginal?.url || url,
            total: Number(recoveryOriginal?.commentCount ?? 0),
            points: recoveryOriginal?.points ?? null,
          }
        : await runWorkflowStepOnce(step, 'fetch complete thread', () => fetchThread(url, fetchOptions))
      if (recoversExistingSource && !thread.id) {
        throw new Error(`Cannot recover ${dramaId}: the episode has no Hacker News source identity.`)
      }

      let sourceTranscript = null
      let sourceMetadata = null
      if (!recoversExistingSource) {
        thread = await convergeIndexLag(step, thread, url, note, fetchOptions)
        thread.article = await runWorkflowStepOnce(step, 'fetch complete source article', async () =>
          thread.articleUrl ? fetchArticle(thread.articleUrl) : null)
        sourceTranscript = threadToTranscript(thread)
        sourceMetadata = buildSourceMetadata(thread, sourceTranscript)
        await patchDrama(db, dramaId, {
          title: thread.title,
          commentCount: thread.total,
          points: thread.points ?? null,
          sourceCompleteness: sourceMetadata.sourceCompleteness,
          // The episode's notes and page link the article the thread discusses.
          articleUrl: thread.articleUrl ? thread.article?.url ?? thread.articleUrl : null,
        })
        await note(verifiedSourceProgress(thread), 'source-completeness-verified')
      }
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
        // Project cast canon: the hosts' pinned portraits AND voices, inherited
        // by every episode at creation. The platform starts a table read only
        // when the canon voices every character, so a canon without the voices
        // is a show that cannot perform. One GET; PATCH only the hosts that
        // differ, compared on the characters alone. A refusal is NOT swallowed:
        // the old catch-all hid a 400 on every PATCH for ten weeks. The
        // readiness preflight runs this same push before it judges the cast.
        const canonRefreshed = await this.hardStep(step, 'ensure cast canon',
          () => syncCastCanonFromPins(db, sh, projectId), { replaySafe: true })
        if (Array.isArray(canonRefreshed) && canonRefreshed.length) {
          await note(`Refreshed the show cast canon for ${canonRefreshed.join(', ')} (portraits + pinned voices)`)
        }

        // One source per thread: the platform returns the source an earlier
        // attempt already captured (`deduplicated`) instead of taking a second
        // copy, so a retry never pays to digest the same thread twice.
        const identity = sourceIdentity(thread)
        const addSource = (label, idempotencyKey) => this.hardStep(step, label, () =>
          sh.addTextSource(projectId, {
            content: sourceTranscript,
            label: `HN thread ${thread.id}`,
            metadata: sourceMetadata,
            ...identity,
            // When the thread was posted: the platform files the episode in
            // that month's season (HNRadio's seasons are calendar months).
            ...sourceOrigin(thread),
            idempotencyKey,
          }), { replaySafe: true })
        await note('Adding the verified full article and comment thread to HNRadio…')
        let captured = capturedSource(await addSource('add source', `${dramaId}-source`))
        let recaptured = false
        if (captured.deduplicated) {
          // Recapture only when the earlier attempt failed BEFORE any plan read
          // the source, the thread has grown materially since, and no other
          // episode of this thread is in flight: the source is one per thread,
          // so a concurrent episode (a visitor's /api/generate) may be planning
          // from it right now. Otherwise the episode is written from the
          // capture the first attempt paid for.
          const recapture = event.payload.sourceRecapture ?? null
          const previousComments = captured.capturedComments ?? recapture?.previousCommentCount ?? null
          // A capture taken before commenters went by pseudonym still names them by username, so it is
          // never written from: it is retired and the thread captured again, renamed.
          const namesUsernames = captured.commenterNames !== COMMENTER_NAMES
          const otherLiveEpisodes = recapture && !namesUsernames
            ? await runWorkflowStepOnce(step, 'other live episodes of this thread', async () =>
              (await listLiveEpisodesOfThread(db, thread.id, 'podcast', dramaId)).map((episode) => episode.id))
            : []
          if (namesUsernames) {
            await note(`The captured source for HN thread ${thread.id} names commenters by username — recapturing it with pseudonyms…`)
            const staleSourceId = captured.id
            await this.hardStep(step, 'retire username source', async () => {
              try {
                await sh.deleteSource(projectId, staleSourceId, {
                  idempotencyKey: `${dramaId}-source-retire-usernames-${staleSourceId}`,
                })
              } catch (error) {
                if (Number(error?.status) !== 404) throw error
              }
            }, { replaySafe: true })
            captured = capturedSource(await addSource('recapture source with pseudonyms', `${dramaId}-source-pseudonyms`))
            recaptured = true
          } else if (recapture && otherLiveEpisodes.length) {
            await note(
              `Keeping the captured source for HN thread ${thread.id}: episode ${otherLiveEpisodes.join(', ')} of this thread is in flight and may be reading it.`,
              'source-recapture-skipped',
            )
          }
          if (namesUsernames) {
            // Recaptured above, renamed; nothing more to decide.
          } else if (recapture && !otherLiveEpisodes.length && threadGrewMaterially(previousComments, thread.total)) {
            await note(`HN thread ${thread.id} grew from ${previousComments} to ${thread.total} comments since the failed attempt — recapturing it…`)
            const staleSourceId = captured.id
            await this.hardStep(step, 'retire stale source', async () => {
              try {
                await sh.deleteSource(projectId, staleSourceId, {
                  idempotencyKey: `${dramaId}-source-retire-${staleSourceId}`,
                })
              } catch (error) {
                // Already gone (an earlier attempt of this step landed).
                if (Number(error?.status) !== 404) throw error
              }
            }, { replaySafe: true })
            captured = capturedSource(await addSource('recapture source', `${dramaId}-source-recapture`))
            recaptured = true
          } else {
            await note(
              `Reusing the source already captured for HN thread ${thread.id}`
              + `${previousComments !== null ? ` (${previousComments} comments)` : ''}.`,
              'source-deduplicated',
            )
          }
        }
        sourceId = captured.id
        if (!sourceId) throw new Error('Sleeper Hit returned no source id for the HN thread.')
        // Record what the episode is written FROM. A reused capture is the
        // earlier thread, not the one fetched this run.
        const reused = captured.deduplicated && !recaptured
        await patchDrama(db, dramaId, {
          sourceId,
          sourceDeduplicated: captured.deduplicated,
          sourceCompleteness: reused ? captured.sourceCompleteness : sourceMetadata.sourceCompleteness,
          ...(reused && captured.capturedComments !== null ? { commentCount: captured.capturedComments } : {}),
        })
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
        // HNR runs unattended under the series' STANDING APPROVAL, bound to its
        // API key. It approves with no human confirmation claim, and only after
        // re-reading that grant: a revoke since the run began stops it here.
        await this.requireStandingApproval(step, { env, db, sh, label: `${label} standing approval` })
        await note('Approving the blueprint under the series\' standing approval…')
        await this.hardStep(step, label, () =>
          sh.request(`/story-plans/${planId}/approve`, {
            method: 'POST',
            idempotencyKey: `${dramaId}-approve-${planId}`,
            body: PLAN_APPROVAL_BODY,
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
              // A typed 4xx is the platform refusing the request itself: a
              // fresh plan earns the same answer. Only failures AROUND a
              // request (a plan that failed to generate, a timeout) re-plan.
              if (classifySystemicFailure(err) || isHttpRefusal(err)) throw err
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
                if (!jobId) {
                  // After a 402 the recovery re-sends the refused request
                  // VERBATIM — same key, same body. The platform binds the job
                  // to the key, and a key re-sent with a different body is a
                  // 409, so the body is replayed from the episode row rather
                  // than rebuilt from a brief whose show memory has moved on.
                  const replay = round === 1 && jobRoll === 0 ? pendingJob : null
                  const jobKey = storyJobKey({ jobScope, round, jobRoll, resumeJobKey: replay?.key })
                  let jobBody = replay?.body ?? null
                  if (!jobBody) {
                    const artifactRequests = buildStoryJobArtifactRequests({
                      existingArtifactId: artifactId,
                      pinnedVoices: includePinnedCast ? pinnedVoices : null,
                      narrationPolicy: 'suppress',
                      notes: brief.performanceNotes,
                    })
                    if (!artifactRequests) throw new Error('Existing artifacts must use resume/repair, not createJob.')
                    jobBody = { storyPlanId: planId, artifactRequests }
                  }
                  try {
                    jobId = await this.hardStep(step, `create job r${round}j${jobRoll}`, () =>
                      sh.request('/story-jobs', {
                        method: 'POST',
                        idempotencyKey: jobKey,
                        body: jobBody,
                      }).then((r) => r.job.id), { replaySafe: true })
                  } catch (err) {
                    if (isInsufficientCredits(err)) {
                      // STOP: no retry buys credits. Keep the request, so the
                      // recovery after a top-up re-sends exactly it (the 402's
                      // details.jobId, when the platform already created the
                      // job, is resumed by the same key — never a second job).
                      await patchDrama(db, dramaId, {
                        planId: jobBody.storyPlanId,
                        pendingJob: {
                          key: jobKey,
                          planId: jobBody.storyPlanId,
                          body: jobBody,
                          refusedJobId: err?.details?.jobId ?? null,
                          // What the refused job costs: the nightly waits for a
                          // balance that covers THIS, not just the typical episode.
                          required: err?.details?.required != null && Number.isFinite(Number(err.details.required)) ? Number(err.details.required) : null,
                          refusedAt: new Date().toISOString(),
                        },
                      })
                      await note(
                        `Out of Studio Credits for the table read (${err?.message || err}) — stopping; `
                        + 'the same job request is re-sent after a top-up.',
                        `insufficient-credits:${jobKey}`,
                      )
                    }
                    throw err
                  }
                }
                await patchDrama(db, dramaId, { jobId, pendingJob: null })
                artifactId = await pollJobArtifact(`job r${round}a${attempt}`, jobId)

                // Length gate: the writer is high-variance — some rolls produce
                // 100+ dialogue entries (~9 min spoken), others 40 (~4 min) from
                // the SAME brief. The audio is always fine; thin episodes were
                // under-WRITTEN, not truncated. Measure actual SPOKEN words and
                // reroll a fresh performance when far under the page target
                // A valid fast panel take lands around 56-60 spoken words/page;
                // reject only below 55/page so we stop discarding good audio.
                const take = await runWorkflowStepOnce(step, `measure r${round}a${attempt}`, async () => {
                  const entries = await sh.getScriptEntries(artifactId)
                  return {
                    spokenWords: entries.reduce(
                      (sum, e) => sum + String(e.text ?? '').trim().split(/\s+/).filter(Boolean).length, 0),
                    offCast: offCastSpeakers(entries, (label) => Boolean(hostForCharacter(label))),
                  }
                }).catch(() => null)
                const spokenWords = take?.spokenWords ?? null

                // The show has FOUR voices and no fifth, ever. The brief says so,
                // but a brief is a request, not a guarantee — so the take is
                // checked rather than trusted. Rolling a fresh one is cheaper
                // than shipping an episode with a stranger in it, and the
                // recast-without-pinned-cast fallback below stays as the last
                // resort if the writer keeps insisting.
                if (take?.offCast?.length && attempt < 3) {
                  await note(`Script gave lines to ${take.offCast.join(', ')} — the cast is the four hosts; rolling a fresh take…`)
                  jobId = null
                  jobRoll++
                  artifactId = null
                  continue
                }
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
                // BEFORE the systemic check, because this one IS systemic by
                // classification and recoverable in fact. "Supply every speaking
                // character" matches CONTRACT_CLASS_RE, so classifying first
                // rethrew the very error this branch exists to absorb — the
                // recovery was unreachable for its own trigger, and a show whose
                // whole premise is reading Hacker News comments aloud opened the
                // generation circuit the first time the writer gave a commenter
                // a line. Recasting without the pinned map is the fix; only once
                // that is exhausted is it genuinely a contract failure.
                if (shouldRecastWithoutPinnedCast({ error: err, includePinnedCast, attempt })) {
                  includePinnedCast = false
                  jobId = null
                  jobRoll++
                  await note('The blueprint cast a guest commenter — recasting with automatic voice assignment…')
                  continue
                }
                // A typed 4xx refusal is final for this request: another job
                // attempt only earns it again (the voiceMap recast above is
                // the one refusal a different request can answer).
                if (classifySystemicFailure(err) || isHttpRefusal(err)) throw err
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
          // fail this one — but a failure is written where the operator reads,
          // not only to a console nobody tails (887 of these went unseen).
          await note(`Show memory not recorded (${err?.message || err})`)
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
      if (await this.episodeDropped(db, dramaId)) return 'dropped'
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

      // Never make a dropped episode playable on the site, even if its MP3 rendered.
      if (await this.episodeDropped(db, dramaId)) return 'dropped'
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
        // HNR no longer logs episodes into the Series Bible: the show's memory
        // lives on its releases (decided 2026-08-08), and the Bible's 100-row
        // episode cap 400'd every append from 08-05 on.
        try {
          const removed = await deleteOtherEpisodesOfThread(db, thread.id, 'podcast', dramaId)
          if (removed) await note(`Replaced ${removed} older episode(s) of this thread.`)
        } catch { /* best-effort */ }
      })
      if (!event.payload.skipPublish) await step.sleep('pre-publish budget break', '6 minutes')
      await this.publishToFeed(step, {
        env, db, sh, dramaId, note, artifactId,
        title: thread.title,
        payload: event.payload,
      })
    } catch (err) {
      const message = err?.message || String(err)
      const failureClass = classifySystemicFailure(err)
      const failure = {
        error: message,
        failureClass,
        failureCode: err?.code || null,
        failureMessage: message,
        // When it failed: the nightly lets a passing readiness read clear a
        // failure only when the read saw the condition AFTER this moment.
        failedAt: new Date().toISOString(),
      }
      if ((isRepair || isResume || isPublishOnly) && recoveryOriginal?.status === 'ready' && recoveryOriginal?.audioUrl) {
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

  async episodeDropped(db, dramaId) {
    return isDroppedEpisode(await getDrama(db, dramaId))
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
    }).catch(async (error) => {
      // A bare "timed out" hides the one fact that explains it. Re-read the
      // manifest — as its own step, so a Workflow replay does not depend on a
      // closure — and name the provider failure the platform already recorded.
      // This is also what lets the nightly CLASSIFY the failure: an exhausted
      // credit balance reaches the reconciler as a quota cliff, which opens the
      // circuit and emails the operator instead of burning attempts silently.
      if (!/timed out/i.test(error?.message || '')) throw error
      const reason = await this.hardStep(
        step,
        `autotune failure reason a${attempt}`,
        async () => (await sh.getVoiceModificationSummary(artifactId, runs)).lastError,
        { replaySafe: true },
      ).catch(() => null)
      if (!reason) throw error
      throw new Error(`${error.message} Last render failure: ${reason}`)
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

  /**
   * Read the series' standing approval for HNR's key, or STOP. Returns the
   * publishing readiness when the grant covers HNR; otherwise throws a typed
   * `approval_missing` error (the grant is absent, revoked, bound to another
   * key, on a paused series, or could not be read). Never approves on doubt.
   */
  async requireStandingApproval(step, { env, db, sh, label }) {
    let publishing
    try {
      publishing = await runWorkflowStepOnce(step, label, async () => {
        const seriesId = await getSetting(db, 'publishingSeriesId')
        let series = null
        let readError = null
        if (seriesId) {
          try {
            series = await sh.getPublishingSeries(seriesId)
          } catch (error) {
            if (!isRefusedRead(error)) throw error
            readError = { status: error.status ?? null, code: error.code ?? null, message: error.message }
          }
        }
        return publishingReadiness({ seriesId, series, readError, keyId: env.SLEEPERHIT_API_KEY_ID || null })
      })
    } catch (error) {
      publishing = {
        state: 'blocked',
        code: 'standing_approval_unreadable',
        reason: `The HNR publishing series could not be read (${error?.message || error}).`,
      }
    }
    if (publishing?.state === 'granted') return publishing
    throw new SleeperHitError(
      `Stopped before spending: HNR runs only under the series' standing approval. ${publishing?.reason || ''}`.trim(),
      { code: publishing?.code || 'standing_approval_missing' },
    )
  }

  /**
   * Put a finished episode on the podcast feed — or record exactly why not.
   *
   * HNR publishes UNATTENDED, so it publishes only under the series' standing
   * approval (bound to HNR's API key) and never claims a human `userConfirmed`.
   * Without the grant, or when the feed refuses, the episode stays 'ready' and
   * playable on hnradio.net with `publishState: 'blocked'` and the refusal's
   * code, and the operator is emailed once. It is never marked 'failed' (that
   * hides it from the site), and a refusal is never swallowed: the old catch-all
   * turned "publishing needs approval" into a nightly paid re-finalize loop.
   */
  async publishToFeed(step, { env, db, sh, dramaId, note, artifactId, title, payload }) {
    if (payload.skipPublish) return 'skipped'
    // The last gate before the feed: a drop during the pre-publish break still keeps it off.
    if (await this.episodeDropped(db, dramaId)) return 'dropped'
    const repairRun = payload.repairArtifactId || payload.repairRunId
    const repairPublicationRequired = Boolean(payload.repairArtifactId)
    let outcome
    try {
      outcome = await this.hardStep(step, 'publish podcast feed', async () => {
        const seriesId = await getSetting(db, 'publishingSeriesId')
        if (!seriesId) {
          if (repairPublicationRequired) throw new Error('Repair publication requires the publishingSeriesId setting.')
          return {
            kind: 'blocked',
            code: 'publishing_series_missing',
            reason: 'No publishing series is configured (settings.publishingSeriesId).',
          }
        }
        if (repairRun) {
          const releaseId = await sh.refreshPublishedEpisodeMedia(seriesId, artifactId, {
            idempotencyKey: `${dramaId}-refresh-media-${payload.repairRunId || 'repair'}`,
          })
          if (!releaseId) {
            throw new Error(`No published release exists for repaired artifact ${artifactId}; refusing to create a duplicate.`)
          }
          return { kind: 'refreshed', releaseId }
        }
        let series = null
        let readError = null
        try {
          series = await sh.getPublishingSeries(seriesId)
        } catch (error) {
          if (!isRefusedRead(error)) throw error
          readError = { status: error.status ?? null, code: error.code ?? null, message: error.message }
        }
        const publishing = publishingReadiness({
          seriesId, series, readError, keyId: env.SLEEPERHIT_API_KEY_ID || null,
        })
        if (publishing.state !== 'granted') {
          // No release is created without the grant: a release made before the
          // grant is not covered by it, and would sit unpublishable forever.
          return { kind: 'blocked', code: publishing.code, reason: publishing.reason }
        }
        // The notes link the episode's thread and article (from its row), and name nobody by username.
        const showNotes = showNotesLinks(await getDrama(db, dramaId))
        const { releaseId, alreadyPublished } = await sh.publishEpisode(seriesId, {
          title,
          showNotes,
          descriptionDirection: EPISODE_DESCRIPTION_DIRECTION,
          artifactId,
          idempotencyKeyPrefix: publishKeyPrefix(dramaId, publishing.grant),
          grantedAt: publishing.grant?.grantedAt ?? null,
        })
        return { kind: 'published', releaseId, alreadyPublished }
      }, { replaySafe: true })
    } catch (err) {
      if (repairPublicationRequired) throw err
      outcome = {
        kind: 'blocked',
        code: err?.code || null,
        status: Number.isInteger(Number(err?.status)) ? Number(err.status) : null,
        reason: err?.message || String(err),
      }
    }

    if (outcome.kind === 'refreshed') {
      await note(`Refreshed repaired media on published release ${outcome.releaseId}.`)
      return outcome.kind
    }
    if (outcome.kind === 'published') {
      await patchDrama(db, dramaId, {
        publishState: 'published',
        releaseId: outcome.releaseId ?? null,
        publishError: null,
        publishFailureCode: null,
        publishBlockedAt: null,
      })
      if (outcome.alreadyPublished) {
        await note(`Release ${outcome.releaseId} was already on the feed; nothing was published twice.`)
      }
      await note(PUBLISHED_PROGRESS_MESSAGE)
      await runWorkflowStepOnce(step, 'clear publish alert latch', () =>
        clearAlertLatch(env, PUBLISH_BLOCKED_ALERT_KEY, { getSetting, setSetting }))
      return outcome.kind
    }
    if (outcome.kind !== 'blocked') return outcome.kind

    await patchDrama(db, dramaId, {
      publishState: 'blocked',
      publishError: outcome.reason,
      publishFailureCode: outcome.code ?? null,
      publishBlockedAt: new Date().toISOString(),
    })
    await note(
      `Podcast publish blocked (${outcome.reason}) — the episode stays on hnradio.net and publishes once the feed accepts it.`,
      `publish-blocked:${outcome.code || 'refused'}`,
    )
    await runWorkflowStepOnce(step, 'publish blocked alert', () => alertOnce(env, PUBLISH_BLOCKED_ALERT_KEY, {
      subject: '[hnradio] finished episodes cannot reach the podcast feed',
      lines: [
        `Episode ${dramaId} ("${title}") is finished and playable on hnradio.net, but the podcast feed refused it.`,
        '',
        `Reason${outcome.code ? ` (${outcome.code})` : ''}: ${outcome.reason}`,
        '',
        'Held episodes keep status "ready" with publishState "blocked"; the nightly retries ONLY the publish step',
        '(no post-production, no re-finalize) once the series reports a standing approval for HNR\'s key.',
        'This email is sent once per outage; the next successful publish re-arms it.',
      ],
    }, { claimSetting, setSetting }))
    return outcome.kind
  }
}
