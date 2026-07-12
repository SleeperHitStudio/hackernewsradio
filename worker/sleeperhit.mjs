

/**
 * A tiny standalone client for the Sleeper Hit Studio Story API (`/api/v1`) —
 * the same surface the official CLI / MCP / mobile app drive. We don't import
 * the monorepo's shared client (this app deploys on its own), so this mirrors
 * its proven contract verbatim: Bearer auth, an idempotency key on reserving
 * POSTs, and a `{ error: { code, message, requestId } }` envelope on failure.
 *
 * The full create→listen chain (table-read plans REQUIRE blueprint review, so
 * the flow approves explicitly before the credit-reserving job):
 *   project → source → plan → approve → job → finalize(audio) → mp3
 */

export class SleeperHitError extends Error {
  constructor(message, { status, code, requestId } = {}) {
    super(message)
    this.name = 'SleeperHitError'
    this.status = status
    this.code = code
    this.requestId = requestId
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class SleeperHit {
  constructor({ baseUrl, apiKey }) {
    if (!apiKey) throw new Error('SleeperHit: missing apiKey')
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.apiKey = apiKey
  }

  async request(path, { method = 'GET', body, idempotencyKey } = {}) {
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (idempotencyKey) headers['Idempotency-Key'] = typeof idempotencyKey === 'string' ? idempotencyKey : crypto.randomUUID()

    let res
    try {
      res = await fetch(`${this.baseUrl}/api/v1${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
    } catch (err) {
      throw new SleeperHitError(`Network error reaching ${this.baseUrl}: ${err.message}`, { status: 0 })
    }

    const text = await res.text()
    let json
    try { json = text ? JSON.parse(text) : {} } catch { json = { raw: text } }

    if (!res.ok) {
      const e = json?.error || {}
      throw new SleeperHitError(e.message || `Story API ${res.status} on ${path}`, {
        status: res.status, code: e.code, requestId: e.requestId,
      })
    }
    return json
  }

  // ── The pipeline ──────────────────────────────────────────────────────────

  async createProject({ name }) {
    const res = await this.request('/story-projects', {
      method: 'POST', idempotencyKey: true, body: { name },
    })
    return res.project.id
  }

  /** Add the thread as a plain-text source (the planner digests it). */
  async addTextSource(projectId, { content, label }) {
    const res = await this.request(`/story-projects/${projectId}/sources`, {
      method: 'POST', idempotencyKey: true,
      body: { type: 'text', content, ...(label ? { label } : {}) },
    })
    return res.source.id
  }

  async pollSourceReady(projectId, sourceId, { onProgress } = {}) {
    for (let i = 0; i < 40; i++) {
      const res = await this.request(`/story-projects/${projectId}/sources/${sourceId}`)
      const status = res.source?.status
      onProgress?.(`source: ${status ?? 'ready'}`)
      // The Story API reports a ready source as 'READY' (or omits status once done).
      if (status === 'READY' || status === undefined) return
      if (status === 'FAILED') throw new SleeperHitError(res.source?.failureMessage || 'Source extraction failed.')
      await sleep(2500)
    }
    throw new SleeperHitError('Source took too long to process.')
  }

  /** `notes` rides on the artifact request and reaches SCRIPT GENERATION
   *  directly as job-level instructions — unlike the creative brief, which the
   *  planner summarizes into a short blueprint (style detail gets lost there). */
  async createTableReadPlan(projectId, { title, target, creativeBrief, styleConstraints, sourceIds, narrationPolicy = 'auto', notes }) {
    const res = await this.request(`/story-projects/${projectId}/story-plans`, {
      method: 'POST', idempotencyKey: true,
      body: {
        title,
        target,
        creativeBrief,
        ...(styleConstraints ? { styleConstraints } : {}),
        sourceIds,
        artifactRequests: [{ type: 'table_read', narrationPolicy, ...(notes ? { notes } : {}) }],
      },
    })
    return res.plan
  }

  async pollPlanForReview(planId, { onProgress } = {}) {
    // Plan generation (source digest + coverage + blueprint) can run ~5 min on
    // a busy queue, so give it a wide ceiling (~13 min) before giving up.
    for (let i = 0; i < 260; i++) {
      const res = await this.request(`/story-plans/${planId}`)
      const status = res.plan?.status
      onProgress?.(`plan: ${status ?? 'generating'}`)
      if (status === 'REQUIRES_APPROVAL' || status === 'APPROVED' || status === 'READY') return res.plan
      if (status === 'FAILED' || status === 'REJECTED') {
        throw new SleeperHitError(res.plan?.failureMessage || 'Plan generation failed.')
      }
      await sleep(3000)
    }
    throw new SleeperHitError('Plan generation timed out.')
  }

  async approvePlan(planId) {
    await this.request(`/story-plans/${planId}/approve`, { method: 'POST', idempotencyKey: true })
  }

  /** artifactRequests OVERRIDE the plan's own requests on the job — this is
   *  the channel that reliably reaches script generation (plan-level notes get
   *  stripped when the plan is stored, verified empirically on job rows). */
  async createJob(storyPlanId, artifactRequests) {
    const res = await this.request('/story-jobs', {
      method: 'POST', idempotencyKey: true,
      body: { storyPlanId, ...(artifactRequests ? { artifactRequests } : {}) },
    })
    return res.job.id
  }

  async pollJobReady(jobId, { onProgress } = {}) {
    // 330 × 4s = 22 min — matches the Story API's PERFORMABLE_POLL_TIMEOUT_MS so
    // hnradio doesn't give up before the server's own budget.
    for (let i = 0; i < 330; i++) {
      const res = await this.request(`/story-jobs/${jobId}`)
      const job = res.job
      const status = job?.status
      const detail = job?.progress?.detail
      onProgress?.(detail ? `job: ${status} — ${detail}` : `job: ${status ?? 'running'}`)
      if (status === 'READY') {
        const art = (job.artifacts ?? []).find((a) => a.type === 'table_read') ?? (job.artifacts ?? [])[0]
        if (!art?.id) throw new SleeperHitError('Job finished but produced no artifact.')
        return art.id
      }
      if (status === 'FAILED' || status === 'CANCELED') {
        throw new SleeperHitError(job?.failureMessage || `Table read ${status}.`)
      }
      await sleep(4000)
    }
    throw new SleeperHitError('Table read generation timed out.')
  }

  // ── Series Bible (project canon) ────────────────────────────────────────────
  // The bible holds the show's canon (cast, world rules, jazz theme) and the
  // episode map; the planner auto-loads it for every plan.

  /** The project's Series Bible document ({ content: { episodes, characters, … } }). */
  async getSeriesBible(projectId) {
    const res = await this.request(`/story-projects/${projectId}/series-bible`)
    return res.document ?? null
  }

  /** Merge-patch the bible (e.g. { content: { episodes } } replaces just that field). */
  async patchSeriesBible(projectId, patch) {
    await this.request(`/story-projects/${projectId}/series-bible`, {
      method: 'PATCH', idempotencyKey: true, body: patch,
    })
  }

  // ── Podcast publishing ──────────────────────────────────────────────────────

  /** Promote a finalized artifact into the series and queue immediate publish.
   *  The series' public RSS feed picks it up (podcast apps poll the feed). */
  async publishEpisode(seriesId, { title, artifactId }) {
    const res = await this.request(`/publishing-series/${seriesId}/releases`, {
      method: 'POST', idempotencyKey: true,
      body: { title: title.slice(0, 200), sourceArtifactId: artifactId, type: 'episode' },
    })
    const releaseId = (res.release ?? res).id
    await this.request(`/publishing-releases/${releaseId}/publish`, {
      method: 'POST', idempotencyKey: true, body: {},
    })
    return releaseId
  }


  /** List the artifact's timed SFX cues. */
  async listSfxCues(artifactId) {
    const res = await this.request(`/artifacts/${artifactId}/sfx`)
    return res.sfx?.cues ?? []
  }

  /** Update a cue in place (retime, rename, re-prompt, mute). */
  async updateSfxCue(artifactId, id, fields) {
    await this.request(`/artifacts/${artifactId}/sfx`, {
      method: 'POST', idempotencyKey: true,
      body: { op: 'update', id, ...fields },
    })
  }

  /** Add a timed sound-effect cue at a dialogue entry. */
  async addSfxCue(artifactId, { entryIndex, label, prompt, volume }) {
    await this.request(`/artifacts/${artifactId}/sfx`, {
      method: 'POST', idempotencyKey: true,
      body: { op: 'add', entryIndex, label, prompt, ...(volume !== undefined ? { volume } : {}) },
    })
  }

  // ── Cast pinning + voice effects ───────────────────────────────────────────
  // Voices can't be pinned at plan time, but a finished read can be recast in
  // place (no new revision, no charge). generate.mjs uses these to keep the
  // recurring hosts on the same voices every episode and to autotune the alien.

  /** The artifact's cast: [{ character, voiceId, voiceName, gender, provider, … }]. */
  async getCast(artifactId) {
    const res = await this.request(`/artifacts/${artifactId}/cast`)
    return res.cast ?? []
  }

  /** Batch-reassign character voices in place: entries = [{ character, voiceId, voiceName, gender?, provider? }]. */
  async updateCast(artifactId, entries) {
    const res = await this.request(`/artifacts/${artifactId}/cast`, {
      method: 'POST', idempotencyKey: true, body: { entries },
    })
    return res.voiceMap ?? res
  }

  /** Recast ONE character's voice via the single-voice route. Unlike the batch
   *  cast route (as deployed), this also invalidates the cached voices-only
   *  track, forcing the next finalize to re-synthesize — which is when ready
   *  voice modifications get projected into the mix. Verified empirically. */
  async recastVoice(artifactId, { character, voiceId, voiceName, gender, provider }) {
    await this.request(`/artifacts/${artifactId}/voice`, {
      method: 'POST', idempotencyKey: true,
      body: {
        character, voiceId, voiceName,
        ...(gender ? { gender } : {}),
        ...(provider ? { provider } : {}),
      },
    })
  }

  /** One character's dialogue entries ({ entryIndex, character, text }), via the script's character scope. */
  async getCharacterEntries(artifactId, character) {
    const qs = `scope=character&character=${encodeURIComponent(character)}&limit=500`
    const res = await this.request(`/artifacts/${artifactId}/script?${qs}`)
    return res.script?.selection?.entries ?? []
  }

  /** Apply the autotune voice effect to a contiguous [start..end] dialogue-entry
   *  range. Async + queued: returns { modificationId, status }; the tuned audio
   *  projects onto the read when the modification reaches 'ready'. Omitted
   *  params fall back to the API's proven defaults (D / minpent / chapel). */
  async applyAutotune(artifactId, startEntryIndex, endEntryIndex, params) {
    return this.request(`/artifacts/${artifactId}/voice-modification`, {
      method: 'POST', idempotencyKey: true,
      body: {
        startEntryIndex,
        endEntryIndex,
        effect: 'autotune',
        ...(params ? { params } : {}),
      },
    })
  }

  /** Re-queue the autotune ranges whose newest record failed (e.g. a queue
   *  consumer with stale env grabbed them). Returns how many were retried. */
  async retryFailedVoiceMods(artifactId) {
    const res = await this.request(`/artifacts/${artifactId}`)
    const mods = res.artifact?.manifest?.audio?.modifications ?? []
    const newest = new Map()
    for (const m of mods) {
      const k = `${m.startEntryIndex}-${m.endEntryIndex}`
      const prev = newest.get(k)
      if (!prev || Date.parse(m.updatedAt || 0) > Date.parse(prev.updatedAt || 0)) newest.set(k, m)
    }
    const failed = [...newest.values()].filter((m) => m.status === 'failed')
    for (const m of failed) {
      await this.applyAutotune(artifactId, m.startEntryIndex, m.endEntryIndex)
    }
    return failed.length
  }

  /** Wait until every voice modification on the artifact settles (newest record
   *  per entry-range is 'ready' or 'failed'). The renders are async + queued;
   *  finalizing before they land would mix the clean takes. Returns
   *  { ready, failed } counts; a timeout just returns the current tally. */
  async waitForVoiceModsSettled(artifactId, { onProgress } = {}) {
    let tally = { ready: 0, failed: 0 }
    for (let i = 0; i < 120; i++) {
      const res = await this.request(`/artifacts/${artifactId}`)
      const mods = res.artifact?.manifest?.audio?.modifications ?? []
      const newest = new Map()
      for (const m of mods) {
        const k = `${m.startEntryIndex}-${m.endEntryIndex}`
        const prev = newest.get(k)
        if (!prev || Date.parse(m.updatedAt || 0) > Date.parse(prev.updatedAt || 0)) newest.set(k, m)
      }
      const v = [...newest.values()]
      tally = {
        ready: v.filter((m) => m.status === 'ready').length,
        failed: v.filter((m) => m.status === 'failed').length,
      }
      const pending = v.length - tally.ready - tally.failed
      onProgress?.(`autotune: ${tally.ready}/${v.length} rendered${pending ? ` (${pending} in flight)` : ''}`)
      if (v.length > 0 && pending === 0) return tally
      if (v.length === 0) return tally
      await sleep(5000)
    }
    return tally
  }

  // ── Defined-clip music shaping (musicMode 'defined_clips') ─────────────────
  // The Story API beds ~50% of the read's scenes with music by default; for the
  // podcast we want a sparse, bookended feel, so after the job we keep only the
  // intro + outro scenes and mute the rest (see shapeMusicToBookends).

  /** Read the artifact's adaptive-soundtrack state ({ musicMode, totalScenes, definedClips[] }). */
  async getMusic(artifactId) {
    const res = await this.request(`/artifacts/${artifactId}/music`)
    return res.music ?? res
  }

  /** Wait until the music-clips worker is fully DONE writing beds. The beds
   *  enqueue async and stream in one by one, so "no clip in-flight right now"
   *  is not enough — between two renders the set looks momentarily quiet. We
   *  require the bed set (count + all-ready) to be STABLE across several polls
   *  before declaring the worker finished, so our later disables don't race a
   *  worker write that would clobber them. */
  async waitForMusicSettled(artifactId, { onProgress } = {}) {
    let last
    let prevSig = ''
    let stable = 0
    for (let i = 0; i < 100; i++) {
      last = await this.getMusic(artifactId)
      if (last.musicMode !== 'defined_clips') return last
      const clips = last.definedClips ?? []
      const ready = clips.filter((c) => c.status === 'ready').length
      const inFlight = clips.some((c) => c.status === 'pending' || c.status === 'rendering')
      const sig = `${clips.length}:${ready}:${inFlight}`
      onProgress?.(`music: clips ${ready}/${clips.length} ready`)
      if (clips.length === 0 && i >= 10) return last // coverage delivered nothing (~30s) — we render our own bookends
      if (clips.length > 0 && !inFlight) {
        stable = sig === prevSig ? stable + 1 : 1
        if (stable >= 3) return last // unchanged for ~9s → worker has stopped
      } else {
        stable = 0
      }
      prevSig = sig
      await sleep(3000)
    }
    return last
  }

  /** Set a soundtrack directive (e.g. the show's jazz theme, screenplay-wide,
   *  mode 'replace' to overwrite the planner's palette) so subsequent clip
   *  renders use it. */
  async setMusicDirective(artifactId, { scope = 'screenplay', mode = 'replace', prompt }) {
    await this.request(`/artifacts/${artifactId}/music`, {
      method: 'POST', idempotencyKey: true, body: { scope, mode, prompt },
    })
  }

  /** Mutate a single scene's defined clip (e.g. { disabled: true } to mute it). */
  async setDefinedClip(artifactId, sceneIndex, clip) {
    await this.request(`/artifacts/${artifactId}/music`, {
      method: 'POST', idempotencyKey: true, body: { sceneIndex, clip },
    })
  }

  /** Render a music bed for explicit scenes (bypasses coverage), then poll until ready. */
  async regenerateMusicScenes(artifactId, sceneIndexes, { onProgress } = {}) {
    if (!sceneIndexes.length) return
    await this.request(`/artifacts/${artifactId}/music`, {
      method: 'POST', idempotencyKey: true, body: { regenerateScenes: sceneIndexes },
    })
    const want = new Set(sceneIndexes)
    for (let i = 0; i < 60; i++) {
      await sleep(3000)
      const music = await this.getMusic(artifactId)
      const clips = (music.definedClips ?? []).filter((c) => want.has(c.sceneIndex))
      const ready = clips.filter((c) => c.status === 'ready').length
      onProgress?.(`music: rendering bookend beds (${ready}/${want.size})`)
      if (clips.length >= want.size && clips.every((c) => c.status === 'ready')) return
      if (clips.some((c) => c.status === 'failed')) throw new SleeperHitError('Bookend music render failed.')
    }
    throw new SleeperHitError('Bookend music render timed out.')
  }

  /** Finalize the durable full-mix MP3 (voices + Lyria music + SFX), then poll until rendered. */
  async finalizeAudio(artifactId, { onProgress } = {}) {
    const first = await this.request(`/artifacts/${artifactId}/finalize`, {
      method: 'POST', idempotencyKey: true, body: { mode: 'audio' },
    })
    const direct = first.finalize?.recordingUrl
    if (direct) return direct

    for (let i = 0; i < 180; i++) {
      await sleep(3000)
      // GET /artifacts/:id nests the manifest under `artifact`.
      const res = await this.request(`/artifacts/${artifactId}`)
      const audio = res.artifact?.manifest?.audio
      onProgress?.(`finalize: ${audio?.finalize?.status ?? 'rendering'}`)
      if (audio?.recordingUrl) return audio.recordingUrl
      if (audio?.finalize?.status === 'failed') {
        throw new SleeperHitError(audio.finalize.error || 'Audio render failed.')
      }
    }
    throw new SleeperHitError('Audio render timed out.')
  }
}
