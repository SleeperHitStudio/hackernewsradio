import { randomUUID } from 'node:crypto'

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
    if (idempotencyKey) headers['Idempotency-Key'] = randomUUID()

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

  async createTableReadPlan(projectId, { title, target, creativeBrief, styleConstraints, sourceIds, narrationPolicy = 'auto' }) {
    const res = await this.request(`/story-projects/${projectId}/story-plans`, {
      method: 'POST', idempotencyKey: true,
      body: {
        title,
        target,
        creativeBrief,
        ...(styleConstraints ? { styleConstraints } : {}),
        sourceIds,
        artifactRequests: [{ type: 'table_read', narrationPolicy }],
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

  async createJob(storyPlanId) {
    const res = await this.request('/story-jobs', {
      method: 'POST', idempotencyKey: true, body: { storyPlanId },
    })
    return res.job.id
  }

  async pollJobReady(jobId, { onProgress } = {}) {
    for (let i = 0; i < 240; i++) {
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
