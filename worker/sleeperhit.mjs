

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
export const STORY_JOB_POLL_ATTEMPTS = 900
export const STORY_JOB_POLL_INTERVAL_MS = 4_000

const rangeKey = ({ start, end, startEntryIndex, endEntryIndex }) =>
  `${Number(start ?? startEntryIndex)}-${Number(end ?? endEntryIndex)}`

function latestVoiceMods(modifications) {
  const latest = new Map()
  for (const [index, modification] of modifications.entries()) {
    const key = rangeKey(modification)
    const parsed = Date.parse(modification.updatedAt || '')
    const timestamp = Number.isFinite(parsed) ? parsed : 0
    const previous = latest.get(key)
    if (!previous || timestamp > previous.timestamp || (timestamp === previous.timestamp && index > previous.index)) {
      latest.set(key, { modification, timestamp, index })
    }
  }
  return new Map([...latest].map(([key, value]) => [key, value.modification]))
}

export function summarizeVoiceModifications(modifications, requestedRanges) {
  const latest = latestVoiceMods(Array.isArray(modifications) ? modifications : [])
  const failedRanges = []
  const statuses = []
  let ready = 0
  let failed = 0
  let pending = 0

  for (const range of requestedRanges) {
    const normalized = { start: Number(range.start), end: Number(range.end) }
    const modification = latest.get(rangeKey(normalized))
    // Missing is deliberately distinct from queued/rendering. Recovery may
    // enqueue a missing range, but must leave an existing in-flight render
    // alone and let the normal poll settle it.
    const status = modification
      ? String(modification.status || 'pending').toLowerCase()
      : 'missing'
    statuses.push({ ...normalized, status })
    if (status === 'ready') ready++
    else if (status === 'failed') {
      failed++
      failedRanges.push(normalized)
    } else pending++
  }

  return { total: requestedRanges.length, ready, failed, pending, failedRanges, statuses }
}

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
  async addTextSource(projectId, { content, label, idempotencyKey }) {
    const res = await this.request(`/story-projects/${projectId}/sources`, {
      method: 'POST', idempotencyKey: idempotencyKey || true,
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
  async createTableReadPlan(projectId, {
    title,
    target,
    creativeBrief,
    styleConstraints,
    sourceIds,
    narrationPolicy = 'auto',
    notes,
    idempotencyKey,
  }) {
    const res = await this.request(`/story-projects/${projectId}/story-plans`, {
      method: 'POST', idempotencyKey: idempotencyKey || true,
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
        throw new SleeperHitError(res.plan?.failureMessage || 'Plan generation failed.', {
          code: res.plan?.failureCode,
        })
      }
      await sleep(3000)
    }
    throw new SleeperHitError('Plan generation timed out.')
  }

  async approvePlan(planId) {
    await this.request(`/story-plans/${planId}/approve`, { method: 'POST', idempotencyKey: true, body: { userConfirmed: true } })
  }

  async resumePlan(planId, idempotencyKey) {
    const res = await this.request(`/story-plans/${planId}/resume`, {
      method: 'POST',
      idempotencyKey: idempotencyKey || true,
    })
    return res.plan
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

  async resumeJob(jobId, idempotencyKey) {
    return this.request(`/story-jobs/${jobId}/resume`, {
      method: 'POST',
      idempotencyKey: idempotencyKey || true,
    })
  }

  async pollJobReady(jobId, { onProgress } = {}) {
    // Sleeper can spend up to 45 minutes performing a StoryJob. Keep polling
    // for 60 minutes so HNR also covers queue/startup overhead around that budget.
    for (let i = 0; i < STORY_JOB_POLL_ATTEMPTS; i++) {
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
        throw new SleeperHitError(job?.failureMessage || `Table read ${status}.`, {
          code: job?.failureCode,
        })
      }
      await sleep(STORY_JOB_POLL_INTERVAL_MS)
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

  // ── Cast canon (project-level pinned portraits + portrait style) ────────────
  // Every new episode inherits these at creation: the platform seeds each
  // matching character's avatarUrl before generation (so canonical portraits
  // are never re-rendered) and installs avatarStyle as the episode's
  // portrait-style override.

  /** { content: { avatarStyle, characters: [{ name, avatarUrl, avatarPrompt }] } } */
  async getCastCanon(projectId) {
    const res = await this.request(`/story-projects/${projectId}/cast-canon`)
    return res.canon ?? null
  }

  /** Merge-patch the canon (characters merge by name). */
  async patchCastCanon(projectId, content) {
    await this.request(`/story-projects/${projectId}/cast-canon`, {
      method: 'PATCH', body: { content },
    })
  }

  // ── Podcast publishing ──────────────────────────────────────────────────────

  /** Promote a finalized artifact into the series and queue immediate publish.
   *  The series' public RSS feed picks it up (podcast apps poll the feed). */
  async publishEpisode(seriesId, {
    title,
    descriptionDirection,
    artifactId,
    seasonNumber = 1,
    idempotencyKeyPrefix,
  }) {
    const res = await this.request(`/publishing-series/${seriesId}/releases`, {
      method: 'POST', idempotencyKey: idempotencyKeyPrefix ? `${idempotencyKeyPrefix}-release` : true,
      body: {
        title: title.slice(0, 200),
        sourceArtifactId: artifactId,
        type: 'episode',
        seasonNumber,
      },
    })
    const releaseId = (res.release ?? res).id
    await this.request(`/publishing-releases/${releaseId}/description/generate`, {
      method: 'POST', idempotencyKey: idempotencyKeyPrefix ? `${idempotencyKeyPrefix}-description` : true,
      body: { direction: descriptionDirection?.slice(0, 2_000) },
    })
    await this.request(`/publishing-releases/${releaseId}/publish`, {
      method: 'POST', idempotencyKey: idempotencyKeyPrefix ? `${idempotencyKeyPrefix}-publish` : true, body: {},
    })
    return releaseId
  }

  async listPublishingReleases(seriesId, { status, limit = 100, cursor } = {}) {
    const query = new URLSearchParams({ limit: String(limit) })
    if (status) query.set('status', status)
    if (cursor) query.set('cursor', cursor)
    const res = await this.request(
      `/publishing-series/${encodeURIComponent(seriesId)}/releases?${query.toString()}`
    )
    return {
      releases: Array.isArray(res.releases) ? res.releases : [],
      nextCursor: res.nextCursor || null,
    }
  }

  async findPublishedReleaseForArtifact(seriesId, artifactId) {
    let cursor
    do {
      const page = await this.listPublishingReleases(seriesId, {
        status: 'published',
        limit: 100,
        cursor,
      })
      const release = page.releases.find((candidate) =>
        candidate?.sourceArtifactId === artifactId
        && String(candidate?.status || '').toLowerCase() === 'published')
      if (release) return release
      cursor = page.nextCursor
    } while (cursor)
    return null
  }

  async refreshPublishedEpisodeMedia(seriesId, artifactId, { idempotencyKey } = {}) {
    const release = await this.findPublishedReleaseForArtifact(seriesId, artifactId)
    if (!release) return null
    await this.request(`/publishing-releases/${encodeURIComponent(release.id)}/refresh-media`, {
      method: 'POST',
      idempotencyKey: idempotencyKey || true,
      body: { sourceArtifactId: artifactId },
    })
    return release.id
  }


  /** List the artifact's timed SFX cues. */
  async listSfxCues(artifactId) {
    const res = await this.request(`/artifacts/${artifactId}/sfx`)
    return res.sfx?.cues ?? []
  }

  /** Update a cue in place (retime, rename, re-prompt, mute). */
  async updateSfxCue(artifactId, id, fields, { idempotencyKey } = {}) {
    const res = await this.request(`/artifacts/${artifactId}/sfx`, {
      method: 'POST', idempotencyKey: idempotencyKey || true,
      body: { op: 'update', id, ...fields },
    })
    return res.cue
  }

  /** Add a timed sound-effect cue at a dialogue entry. */
  async addSfxCue(artifactId, {
    entryIndex,
    label,
    prompt,
    volume,
    generatedDurationS,
    enabled,
    idempotencyKey,
  }) {
    const res = await this.request(`/artifacts/${artifactId}/sfx`, {
      method: 'POST', idempotencyKey: idempotencyKey || true,
      body: {
        op: 'add',
        entryIndex,
        label,
        prompt,
        ...(volume !== undefined ? { volume } : {}),
        ...(generatedDurationS !== undefined ? { generatedDurationS } : {}),
        ...(enabled !== undefined ? { enabled } : {}),
      },
    })
    return res.cue
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
  async applyAutotune(artifactId, startEntryIndex, endEntryIndex, params, { idempotencyKey } = {}) {
    return this.request(`/artifacts/${artifactId}/voice-modification`, {
      method: 'POST', idempotencyKey: idempotencyKey || true,
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
  async retryFailedVoiceMods(artifactId, { ranges, idempotencyKeyPrefix = `${artifactId}-autotune-retry` } = {}) {
    let failedRanges = ranges
    if (!Array.isArray(failedRanges)) {
      const res = await this.request(`/artifacts/${artifactId}`)
      const mods = res.artifact?.manifest?.audio?.modifications ?? []
      failedRanges = [...latestVoiceMods(mods).values()]
        .filter((modification) => String(modification.status || '').toLowerCase() === 'failed')
        .map((modification) => ({
          start: Number(modification.startEntryIndex),
          end: Number(modification.endEntryIndex),
        }))
    }
    for (const range of failedRanges) {
      await this.applyAutotune(artifactId, range.start, range.end, undefined, {
        idempotencyKey: `${idempotencyKeyPrefix}-${range.start}-${range.end}`,
      })
    }
    return failedRanges.length
  }

  async getVoiceModificationSummary(artifactId, requestedRanges) {
    const res = await this.request(`/artifacts/${artifactId}`)
    const modifications = res.artifact?.manifest?.audio?.modifications ?? []
    return summarizeVoiceModifications(modifications, requestedRanges)
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
  async setMusicDirective(artifactId, { scope = 'screenplay', mode = 'replace', prompt }, { idempotencyKey } = {}) {
    await this.request(`/artifacts/${artifactId}/music`, {
      method: 'POST', idempotencyKey: idempotencyKey || true, body: { scope, mode, prompt },
    })
  }

  /** Mutate a single scene's defined clip (e.g. { disabled: true } to mute it). */
  async setDefinedClip(artifactId, sceneIndex, clip, { idempotencyKey } = {}) {
    await this.request(`/artifacts/${artifactId}/music`, {
      method: 'POST', idempotencyKey: idempotencyKey || true, body: { sceneIndex, clip },
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
