/**
 * The generation pipeline as a Cloudflare Workflow — a durable port of
 * server/generate.mjs runPipeline. Long polls are chunked into bounded
 * step.do calls (a chunk of GET polls is idempotent and safe to replay);
 * credit-reserving POSTs get DETERMINISTIC idempotency keys so a step retry
 * can never double-spend.
 */
import { WorkflowEntrypoint } from 'cloudflare:workers'
import { SleeperHit } from './sleeperhit.mjs'
import { fetchThread, threadToTranscript } from './hn.mjs'
import { buildBrief, pageTargetFor, hostForCharacter, HOSTS, OUTPUT_BUDGET_RE } from './brief.mjs'
import { patchDrama, appendProgress, getSetting, setSetting, deleteOtherEpisodesOfThread } from './store.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class HnrPipeline extends WorkflowEntrypoint {
  async run(event, step) {
    const { dramaId, url, staggerSec = 0 } = event.payload
    const env = this.env
    const db = env.DB
    const sh = new SleeperHit({ baseUrl: env.SLEEPERHIT_API_BASE, apiKey: env.SLEEPERHIT_API_KEY })
    const note = (m) => appendProgress(db, dramaId, m).catch(() => {})

    try {
      if (staggerSec > 0) await step.sleep('stagger', `${staggerSec} seconds`)

      const thread = await step.do('fetch thread', () => fetchThread(url))
      await patchDrama(db, dramaId, { status: 'running' })

      // ── Source ─────────────────────────────────────────────────────────────
      const projectId = env.HNRADIO_PROJECT_ID
      await note('Adding this episode to HNRadio…')
      const sourceId = await step.do('add source', () =>
        sh.addTextSource(projectId, { content: threadToTranscript(thread), label: `HN thread ${thread.id}` }))
      await this.pollChunked(step, 'source', 8, async () => {
        const res = await sh.request(`/story-projects/${projectId}/sources/${sourceId}`)
        const status = res.source?.status
        if (status === 'READY' || status === undefined) return 'done'
        if (status === 'FAILED') throw new Error(res.source?.failureMessage || 'Source extraction failed.')
        return 'pending'
      })

      // ── Plan + perform with the adaptive page target ───────────────────────
      let pageTarget = pageTargetFor(thread)
      let artifactId = null
      for (let round = 1; artifactId === null; round++) {
        const brief = buildBrief(thread, pageTarget)
        let planId = null
        for (let attempt = 1; attempt <= 4 && !planId; attempt++) {
          await note(attempt === 1
            ? `Planning the podcast at ${pageTarget} pages (cast, scenes, music, SFX)…`
            : `Re-planning (attempt ${attempt})…`)
          try {
            const plan = await step.do(`create plan r${round}a${attempt}`, () => sh.createTableReadPlan(projectId, {
              title: brief.title,
              target: brief.target,
              creativeBrief: brief.creativeBrief,
              styleConstraints: brief.styleConstraints,
              sourceIds: [sourceId],
              narrationPolicy: 'suppress',
            }))
            await patchDrama(db, dramaId, { planId: plan.id })
            const status = await this.pollChunked(step, `plan r${round}a${attempt}`, 25, async () => {
              const res = await sh.request(`/story-plans/${plan.id}`)
              const s = res.plan?.status
              if (s === 'REQUIRES_APPROVAL' || s === 'APPROVED' || s === 'READY') return s
              if (s === 'FAILED' || s === 'REJECTED') throw new Error(res.plan?.failureMessage || 'Plan generation failed.')
              return 'pending'
            })
            if (status === 'REQUIRES_APPROVAL') {
              await note('Approving the blueprint…')
              await step.do(`approve r${round}a${attempt}`, () =>
                sh.request(`/story-plans/${plan.id}/approve`, { method: 'POST', idempotencyKey: `${dramaId}-approve-${plan.id}` }))
            }
            planId = plan.id
          } catch (err) {
            if (attempt === 4) throw err
            await note(`Plan attempt ${attempt} failed (${err?.message || err}); retrying…`)
          }
        }

        await note('Performing the podcast — writing, voicing, scoring…')
        try {
          let jobId = null
          for (let attempt = 1; attempt <= 3 && artifactId === null; attempt++) {
            try {
              // Resume the round's existing job on retry — a client-side poll
              // failure does NOT mean the server-side job failed, and a fresh
              // job would double-spend credits.
              jobId = jobId ?? await step.do(`create job r${round}`, () =>
                sh.request('/story-jobs', {
                  method: 'POST',
                  idempotencyKey: `${dramaId}-job-r${round}`,
                  body: {
                    storyPlanId: planId,
                    artifactRequests: [{ type: 'table_read', narrationPolicy: 'suppress', notes: brief.performanceNotes }],
                  },
                }).then((r) => r.job.id))
              await patchDrama(db, dramaId, { jobId })
              artifactId = await this.pollChunked(step, `job r${round}a${attempt}`, 40, async () => {
                const res = await sh.request(`/story-jobs/${jobId}`)
                const job = res.job
                if (job?.status === 'READY') {
                  const art = (job.artifacts ?? []).find((a) => a.type === 'table_read') ?? (job.artifacts ?? [])[0]
                  if (!art?.id) throw new Error('Job finished but produced no artifact.')
                  return art.id
                }
                if (job?.status === 'FAILED' || job?.status === 'CANCELED') {
                  throw new Error(job?.failureMessage || `Table read ${job?.status}.`)
                }
                return 'pending'
              })
            } catch (err) {
              const msg = err?.message || String(err)
              const overBudget = OUTPUT_BUDGET_RE.test(msg)
              const transient = !/time budget/i.test(msg)
              if (attempt === 3 || !transient || (overBudget && attempt >= 2)) throw err
              // Server-side terminal failure → new job next attempt; anything
              // else (network/poll trouble) resumes the same job.
              if (/FAILED|CANCELED|generation failed/i.test(msg)) jobId = null
              await note(`Performance attempt ${attempt} failed (${msg}); retrying…`)
            }
          }
        } catch (err) {
          const msg = err?.message || String(err)
          if (round < 3 && pageTarget > 4 && OUTPUT_BUDGET_RE.test(msg)) {
            pageTarget = Math.max(4, pageTarget - 3)
            await note(`Script blew the writer's output budget — re-planning tighter at ${pageTarget} pages…`)
            continue
          }
          throw err
        }
      }
      await patchDrama(db, dramaId, { artifactId })

      // ── Post-production (each best-effort, mirroring the server) ───────────
      await step.sleep('post-prod break 1', '2 seconds')
      await step.do('pin voices', async () => {
        try { await this.pinHostVoices(db, sh, dramaId, artifactId) } catch (err) {
          await note(`Voice pinning skipped (${err?.message || err})`)
        }
      })
      await step.sleep('post-prod break 2', '2 seconds')
      await step.do('autotune dial', async () => {
        try { await this.autotuneAlien(db, sh, dramaId, artifactId) } catch (err) {
          await note(`Alien autotune skipped (${err?.message || err})`)
        }
      })
      await step.sleep('post-prod break 2b', '2 seconds')
      await step.do('normalize cable static', async () => {
        // Gary's cable gag: whatever the writer/detector authored, the SOUND is
        // always the same canonical 1-2s of soft radio static — an identical
        // prompt reuses ONE banked asset via the SFX library (like the theme).
        try {
          const cues = await sh.listSfxCues(artifactId)
          for (const c of cues) {
            if (/static|unplug|cable|disconnect/i.test(`${c.label} ${c.prompt}`)) {
              await sh.updateSfxCue(artifactId, c.id, {
                label: 'Cable Static',
                prompt: 'one to two seconds of soft radio static, like snow on an old television — low, muffled, gentle',
                volume: 0.5,
              })
            }
          }
        } catch { /* best-effort */ }
      })
      await step.sleep('post-prod break 3', '2 seconds')
      await step.do('pin headshots', async () => {
        try {
          await sh.updateCast(artifactId, HOSTS.map((h) => ({
            character: h.name,
            avatarUrl: `https://hnradio.net/avatars/${h.name.toLowerCase()}.png`,
          })))
        } catch { /* older API */ }
      })
      await step.sleep('post-prod break 4', '2 seconds')
      await this.shapeMusic(step, db, sh, dramaId, artifactId, note)

      // ── Finalize ───────────────────────────────────────────────────────────
      await note('Mixing the durable MP3 (voices + music + SFX)…')
      await step.sleep('pre-finalize break', '2 seconds')
      const first = await step.do('finalize', () =>
        sh.request(`/artifacts/${artifactId}/finalize`, {
          method: 'POST', idempotencyKey: `${dramaId}-finalize`, body: { mode: 'audio' },
        }))
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

      await patchDrama(db, dramaId, { status: 'ready', audioUrl, error: null })
      await note('Done — your podcast is ready.')

      await step.sleep('post-ready break', '2 seconds')
      await step.do('replace + log + publish', async () => {
        try {
          const removed = await deleteOtherEpisodesOfThread(db, thread.id, 'podcast', dramaId)
          if (removed) await note(`Replaced ${removed} older episode(s) of this thread.`)
        } catch { /* best-effort */ }
        try { await this.logEpisodeInBible(sh, projectId, thread) } catch (err) {
          await note(`Series Bible episode log skipped (${err?.message || err})`)
        }
        try {
          const seriesId = await getSetting(db, 'publishingSeriesId')
          if (seriesId) {
            await sh.publishEpisode(seriesId, { title: thread.title, artifactId })
            await note('Published to the HNR podcast feed.')
          }
        } catch (err) {
          await note(`Podcast publish skipped (${err?.message || err})`)
        }
      })
    } catch (err) {
      await patchDrama(db, dramaId, { status: 'failed', error: err?.message || String(err) })
      await note(`Failed: ${err?.message || err}`)
      throw err
    }
  }

  /** One cheap status probe per engine invocation, with LONG durable sleeps
   *  between probes — short sleeps coalesce into a single invocation and the
   *  accumulated fetches blow Workers' per-invocation subrequest budget
   *  (observed twice in production). */
  async pollChunked(step, label, maxChunks, chunk) {
    for (let n = 0; n < maxChunks; n++) {
      const out = await step.do(`${label} poll#${n}`, chunk)
      if (out !== 'pending') return out
      await step.sleep(`${label} wait#${n}`, '45 seconds')
    }
    throw new Error(`${label} timed out.`)
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

  async autotuneAlien(db, sh, dramaId, artifactId) {
    const cast = await sh.getCast(artifactId)
    const alien = cast.find((c) => hostForCharacter(c.character)?.alien)
    if (!alien) return
    const entries = await sh.getCharacterEntries(artifactId, alien.character)
    const marked = entries.filter((e) => /dial/i.test(e.parenthetical || ''))
    const indexes = [...new Set(marked.map((e) => e.entryIndex))].sort((a, b) => a - b)
    if (!indexes.length) {
      await appendProgress(db, dramaId, `autotune: ${alien.character} kept the dial off this episode`)
      return
    }
    const runs = []
    for (const i of indexes) {
      const last = runs[runs.length - 1]
      if (last && i === last.end + 1) last.end = i
      else runs.push({ start: i, end: i })
    }
    for (const r of runs) {
      await sh.applyAutotune(artifactId, r.start, r.end)
      try {
        await sh.addSfxCue(artifactId, {
          entryIndex: r.start,
          label: 'Dial Click',
          prompt: 'a single small subtle mechanical click, like a tiny dial or switch',
          volume: 0.35,
        })
      } catch { /* click optional */ }
    }
    await appendProgress(db, dramaId, `autotune: ${alien.character} turned the dial — ${indexes.length} line(s) across ${runs.length} range(s)`)
  }

  async shapeMusic(step, db, sh, dramaId, artifactId, note) {
    try {
      const music = await step.do('music state', () => sh.getMusic(artifactId))
      if (music?.musicMode !== 'defined_clips') return
      const total = Number(music.totalScenes) || 0
      if (total < 1) return
      const introIndex = 0
      const outroIndex = Math.max(0, total - 1)

      // WAIT for the platform's baseline coverage renders to fully settle
      // BEFORE installing/muting anything — an in-flight render completing
      // later overwrites clip records (it clobbered the banked theme and
      // un-muted mid-show beds in production).
      await this.pollChunked(step, 'music settle', 10, async () => {
        const m = await sh.getMusic(artifactId)
        const inFlight = (m.definedClips ?? []).some((c) => c.status === 'pending' || c.status === 'rendering')
        return inFlight ? 'pending' : 'done'
      }).catch(() => { /* settle timeout — proceed anyway */ })

      const banked = await getSetting(db, 'jazzTheme')
      let injected = false
      if (banked?.intro?.soundUrl && banked?.outro?.soundUrl) {
        await note('music: installing the banked jazz theme bookends')
        await step.do('install theme', async () => {
          await sh.setDefinedClip(artifactId, introIndex, {
            soundUrl: banked.intro.soundUrl,
            ...(banked.intro.durationMs ? { durationMs: banked.intro.durationMs } : {}),
            playMode: 'once',
          })
          await sh.setDefinedClip(artifactId, outroIndex, {
            soundUrl: banked.outro.soundUrl,
            ...(banked.outro.durationMs ? { durationMs: banked.outro.durationMs } : {}),
            playMode: 'once',
            anchor: 'end',
          })
        })
        const check = await step.do('verify theme', () => sh.getMusic(artifactId))
        const ok = (i, u) => (check.definedClips ?? []).some((c) => c.sceneIndex === i && c.status === 'ready' && c.soundUrl === u)
        injected = ok(introIndex, banked.intro.soundUrl) && ok(outroIndex, banked.outro.soundUrl)
        if (!injected) await note('music: banked-theme injection not supported by the API yet — falling back to a fresh render')
      }
      if (!injected) {
        await step.do('jazz directive', () => sh.setMusicDirective(artifactId, {
          prompt:
            'The show theme: sleazy late-night jazz — walking upright bass, brushed drums, smoky saxophone, a touch ' +
            'of Rhodes; slow, too cool for the content, played straight.',
        }))
        await note(`music: rendering the jazz theme bookends (scenes ${introIndex} + ${outroIndex})`)
        await step.do('render beds', () => sh.request(`/artifacts/${artifactId}/music`, {
          method: 'POST', idempotencyKey: `${dramaId}-beds`, body: { regenerateScenes: [introIndex, outroIndex] },
        }))
        await this.pollChunked(step, 'beds', 12, async () => {
          const m = await sh.getMusic(artifactId)
          const clips = (m.definedClips ?? []).filter((c) => [introIndex, outroIndex].includes(c.sceneIndex))
          if (clips.length >= (total === 1 ? 1 : 2) && clips.every((c) => c.status === 'ready')) return 'done'
          if (clips.some((c) => c.status === 'failed')) throw new Error('Bookend music render failed.')
          return 'pending'
        })
        await step.do('anchor outro', () =>
          sh.setDefinedClip(artifactId, outroIndex, { anchor: 'end' }).catch(() => {}))
        // Self-bank this render as THE theme for future episodes.
        const state = await step.do('bank check', () => sh.getMusic(artifactId))
        const clipFor = (i) => (state.definedClips ?? []).find((c) => c.sceneIndex === i && c.status === 'ready' && c.soundUrl)
        const intro = clipFor(introIndex)
        const outro = clipFor(outroIndex)
        if (intro && outro) {
          await setSetting(db, 'jazzTheme', {
            intro: { soundUrl: intro.soundUrl, durationMs: intro.durationMs ?? null },
            outro: { soundUrl: outro.soundUrl, durationMs: outro.durationMs ?? null },
            bankedAt: new Date().toISOString(),
          })
          await note('music: jazz theme BANKED — future episodes reuse these exact recordings')
        }
      }
      // Mute any non-bookend beds the baseline coverage delivered.
      await step.do('mute middles', async () => {
        const state = await sh.getMusic(artifactId)
        for (const c of state.definedClips ?? []) {
          if (![introIndex, outroIndex].includes(c.sceneIndex) && !c.disabled) {
            await sh.setDefinedClip(artifactId, c.sceneIndex, { disabled: true })
          }
        }
      })
    } catch (err) {
      await note(`music: jazz bookends skipped (${err?.message || err})`)
    }
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
