/**
 * The recurring producer's READINESS PREFLIGHT: before the nightly spends
 * anything on an episode, one read of the project, one of the balance and one
 * of the publishing series say whether an episode can succeed at all.
 *
 *   GET /story-projects/{id}     → project.workspaceGate { ready, stage, reason, missingFields, canPlan, canStartEpisode }
 *                                  project.tableReadReadiness { ready, audioOnly, reason, narratorVoice, members }
 *   GET /credits                 → credits.balance
 *   GET /publishing-series/{id}  → series.standingApproval { keyId, keyName, keyStart, grantedAt, grantedBy } | null
 *
 * HNR owns its hosts' voices (D1 `pinnedVoices`). When the project says the
 * cast is not ready, the preflight first pushes those voices into the cast
 * canon (GET /story-projects/{id}/cast-canon, a PATCH only when stale; free)
 * and re-reads the project, so a canon missing a voice HNR has pinned heals
 * itself instead of stopping the show. A voice HNR has not pinned is never
 * invented: that cast stays `cast_not_ready`.
 *
 * HNR is UNATTENDED. It approves plans and publishes only under the series'
 * standing approval, bound to ITS API key (SLEEPERHIT_API_KEY_ID), and never by
 * claiming a human `userConfirmed`. Without that grant it spends nothing.
 *
 * A read reports which conditions it MEASURED (`measured`): the nightly lets a
 * passing read clear only a failure the read can actually see. Everything here
 * is pure except `readReadiness`, which takes the client as an argument.
 */
import { SleeperHit } from './sleeperhit.mjs'
import { syncCastCanonFromPins } from './cast-canon.mjs'
import { CAST_CANON_SYNC_REFUSED_CODE } from './failure-classification.mjs'

/** A table read (~20) plus its audio finalize (6): what one episode costs. */
export const MIN_EPISODE_CREDITS = 26

/** Series statuses whose standing approval the platform exercises (PR 6). */
const EXERCISABLE_SERIES_STATUSES = Object.freeze(['active', 'draft'])

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function sentence(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text || fallback
}

/** The cast members a table read cannot voice yet, as "NAME (missing, …)". */
function uncastMembers(tableRead) {
  return (Array.isArray(tableRead.members) ? tableRead.members : [])
    .filter((member) => isRecord(member) && member.ready === false)
    .map((member) => {
      const missing = Array.isArray(member.missing) ? member.missing.map(String) : []
      return `${String(member.name)}${missing.length ? ` (${missing.join(', ')})` : ''}`
    })
}

/**
 * The approval half of readiness: no failure when the series' standing
 * approval covers HNR's key, otherwise an `approval_missing` failure naming
 * why. `publishing` is `publishingReadiness(...)`; an absent value is not a
 * measurement and yields no failure.
 */
export function approvalFailure(publishing) {
  if (!isRecord(publishing) || publishing.state === 'granted') return null
  return {
    ready: false,
    failureClass: 'approval_missing',
    code: publishing.code || 'standing_approval_missing',
    message: `HNRadio has no standing approval to spend or publish unattended: ${sentence(publishing.reason, 'grant the HNR series\' standing approval to HNR\'s API key.')}`,
    details: { code: publishing.code || null },
  }
}

/**
 * Whether the project can start an episode. Returns the FIRST reason it
 * cannot, as one of the readiness failure classes, or `ready: true` — and in
 * both cases the classes this read measured.
 */
export function evaluateReadiness({ project, credits, publishing = null, minCredits = MIN_EPISODE_CREDITS } = {}) {
  const gate = isRecord(project?.workspaceGate) ? project.workspaceGate : null
  const tableRead = isRecord(project?.tableReadReadiness) ? project.tableReadReadiness : null
  const balance = Number(credits?.balance)
  const hasBalance = isRecord(credits) && Number.isFinite(balance)
  // A successful project + credits read proves the key and the project are reachable.
  const measured = ['access']
  if (gate) measured.push('project_not_ready')
  if (tableRead) measured.push('cast_not_ready')
  if (isRecord(publishing)) measured.push('approval_missing')
  if (hasBalance) measured.push('quota')

  if (gate && (gate.ready === false || gate.canStartEpisode === false)) {
    const stage = typeof gate.stage === 'string' ? gate.stage : 'unknown'
    return {
      ready: false,
      failureClass: 'project_not_ready',
      code: 'project_precondition_failed',
      message: `HNRadio project is not ready (stage ${stage}): ${sentence(gate.reason, 'finish that stage before the next episode.')}`,
      details: {
        stage,
        missingFields: Array.isArray(gate.missingFields) ? gate.missingFields.map(String) : [],
        canPlan: gate.canPlan ?? null,
        canStartEpisode: gate.canStartEpisode ?? null,
      },
      measured,
    }
  }

  if (tableRead && tableRead.ready === false) {
    return {
      ready: false,
      failureClass: 'cast_not_ready',
      code: 'cast_precondition_failed',
      message: `HNRadio cannot start a table read: ${sentence(tableRead.reason, 'the cast canon does not cover every character.')}`,
      details: { missing: uncastMembers(tableRead) },
      measured,
    }
  }

  const approval = approvalFailure(publishing)
  if (approval) return { ...approval, measured }

  if (hasBalance && balance < minCredits) {
    return {
      ready: false,
      failureClass: 'quota',
      code: 'insufficient_credits',
      message: `Not enough Studio Credits for an episode: the balance is ${balance}, one episode needs ${minCredits}. Top up to resume the show.`,
      details: { balance, required: minCredits },
      measured,
    }
  }

  return { ready: true, failureClass: null, code: null, message: null, details: null, measured }
}

/**
 * Whether HNR may approve plans and publish to the series WITHOUT asserting a
 * human confirmation. The platform (PR 6) reports the grant as
 * `series.standingApproval = { keyId, grantedAt, … }`, or null when there is
 * none (never granted, or revoked). It covers HNR only when it is bound to
 * HNR's own key id, on an audio series that is active or draft.
 *
 * `state` is 'granted', 'blocked' or 'none' (no series configured); `grant` is
 * `{ keyId, grantedAt }` once granted.
 */
export function publishingReadiness({ seriesId, series, readError = null, keyId = null } = {}) {
  const blocked = (code, reason) => ({ state: 'blocked', code, reason, grant: null })
  if (!seriesId) {
    return {
      state: 'none',
      code: 'publishing_series_missing',
      reason: 'No publishing series is configured (settings.publishingSeriesId); HNR approves and publishes only under a series\' standing approval.',
      grant: null,
    }
  }
  if (readError) {
    const status = readError.status ? `${readError.status} ` : ''
    const code = readError.code ? `${readError.code}: ` : ''
    return blocked('standing_approval_unreadable',
      `The HNR publishing series could not be read (${status}${code}${readError.message || readError}).`)
  }
  if (!isRecord(series)) {
    return blocked('standing_approval_unreadable', 'The platform returned no HNR publishing series.')
  }
  if (!('standingApproval' in series)) {
    return blocked('standing_approval_unavailable',
      'The platform does not report a standing approval for the HNR series yet; HNR spends and publishes nothing until it does.')
  }
  const grant = isRecord(series.standingApproval) ? series.standingApproval : null
  if (!grant) {
    return blocked('standing_approval_missing',
      'The HNR series has no standing approval (never granted, or revoked); grant it to HNR\'s key on the Publishing tab to run the show unattended.')
  }
  if (!keyId) {
    return blocked('standing_approval_unverifiable',
      'SLEEPERHIT_API_KEY_ID is not set, so HNR cannot confirm the series\' standing approval is bound to its own key.')
  }
  if (grant.keyId !== keyId) {
    return blocked('standing_approval_other_key', grant.keyId
      ? 'The HNR series\' standing approval is bound to a different API key; re-grant it to HNR\'s key on the Publishing tab.'
      : 'The HNR series\' standing approval is held by the built-in cadence runner, not an API key; grant it to HNR\'s key on the Publishing tab.')
  }
  if (typeof series.status === 'string' && !EXERCISABLE_SERIES_STATUSES.includes(series.status)) {
    return blocked('standing_approval_inactive',
      `The HNR series is ${series.status}; a paused or archived series\' standing approval covers nothing.`)
  }
  if (typeof series.medium === 'string' && series.medium !== 'audio') {
    return blocked('standing_approval_inactive',
      `The HNR series is ${series.medium}; a standing approval covers audio series only.`)
  }
  return {
    state: 'granted',
    code: null,
    reason: null,
    grant: { keyId: grant.keyId, grantedAt: typeof grant.grantedAt === 'string' ? grant.grantedAt : null },
  }
}

/**
 * The idempotency prefix for an episode's release/description/publish calls.
 * Scoped to the grant: a release is covered by the standing approval only when
 * it is created AFTER the grant, so a re-grant starts a fresh release (and the
 * client cancels the one the old grant left unpublished).
 */
export function publishKeyPrefix(dramaId, grant) {
  const grantedMs = Date.parse(grant?.grantedAt ?? '')
  const scope = Number.isFinite(grantedMs) ? `g${grantedMs.toString(36)}` : 'g0'
  return `${dramaId}-publish-${scope}`
}

function refusalOf(error) {
  return {
    message: error?.message || String(error),
    code: error?.code || null,
    status: Number.isInteger(Number(error?.status)) ? Number(error.status) : null,
  }
}

/**
 * A read the Story API REFUSED: an authoritative 4xx (not 408/425/429). A
 * revoked or rotated key, a missing scope, a deleted project. Unlike a network
 * error or a 5xx it will refuse the same way every hour until someone acts.
 */
export function isRefusedRead(error) {
  const status = Number(error?.status)
  return Number.isInteger(status) && status >= 400 && status < 500 && ![408, 425, 429].includes(status)
}

/**
 * The failure a REFUSED project or credits read means: the key or the project
 * is broken (`access`), and the operator must be told.
 */
export function accessFailure(stage, error) {
  const refusal = refusalOf(error)
  return {
    checked: true,
    ready: false,
    failureClass: 'access',
    code: refusal.code || `http_${refusal.status}`,
    message: `The Story API refused HNR's ${stage} read (${refusal.status}${refusal.code ? ` ${refusal.code}` : ''}): ${refusal.message}`,
    details: { stage, status: refusal.status, code: refusal.code },
    measured: ['access'],
    balance: null,
    publishing: null,
  }
}

/**
 * The failure a REFUSED cast canon push means: HNR has pinned the voices, but
 * the Story API would not take them (a strict-schema 400, a missing write
 * scope). Still the cast: no table read can be voiced until the push lands,
 * and each hourly read retries it (free). `verdict` is the cast verdict the
 * push was meant to heal.
 */
export function castSyncFailure(verdict, error) {
  const refusal = refusalOf(error)
  return {
    ready: false,
    failureClass: 'cast_not_ready',
    code: CAST_CANON_SYNC_REFUSED_CODE,
    message: `HNRadio cannot start a table read: the Story API refused HNR's push of its pinned host voices to the cast canon (${refusal.status}${refusal.code ? ` ${refusal.code}` : ''}): ${refusal.message}`,
    details: {
      missing: Array.isArray(verdict?.details?.missing) ? verdict.details.missing : [],
      canonSync: { status: refusal.status, code: refusal.code },
    },
    measured: verdict?.measured ?? ['access', 'cast_not_ready'],
  }
}

/**
 * Perform the preflight reads. Never throws.
 *
 * - A read that could not be made (network error, 5xx, 429) is `checked: false`:
 *   not evidence of anything, so the caller skips the tick's generation.
 * - A project or credits read the API REFUSED is an `access` failure: the key
 *   or the project is broken, and the operator must be told.
 * - A series read the API refused is an unreadable grant (`approval_missing`).
 * - With `db`, a cast the project reports not ready is first synced from the
 *   D1 `pinnedVoices` (syncCastCanonFromPins) and, when that wrote anything,
 *   judged again on a fresh project read. A push the API refused is a
 *   `cast_not_ready` failure naming the refusal; one that could not be made is
 *   `checked: false`, like any read.
 */
export async function readReadiness(sh, {
  projectId,
  seriesId = null,
  keyId = null,
  minCredits = MIN_EPISODE_CREDITS,
  db = null,
  readSetting,
} = {}) {
  const refused = accessFailure
  let project = null
  let credits = null
  try {
    project = await sh.getProject(projectId)
  } catch (error) {
    if (isRefusedRead(error)) return refused('project', error)
    return { checked: false, error: refusalOf(error), stage: 'project' }
  }
  try {
    credits = await sh.getCredits()
  } catch (error) {
    if (isRefusedRead(error)) return refused('credits', error)
    return { checked: false, error: refusalOf(error), stage: 'credits' }
  }
  let series = null
  let seriesError = null
  if (seriesId) {
    try {
      series = await sh.getPublishingSeries(seriesId)
    } catch (error) {
      if (!isRefusedRead(error)) return { checked: false, error: refusalOf(error), stage: 'series' }
      seriesError = refusalOf(error)
    }
  }
  const publishing = publishingReadiness({ seriesId, series, readError: seriesError, keyId })
  let verdict = evaluateReadiness({ project, credits, publishing, minCredits })
  if (db && verdict.failureClass === 'cast_not_ready') {
    // Before a cast verdict stops the show: push the voices HNR itself pinned,
    // then judge the canon that push wrote.
    let written = []
    try {
      written = await syncCastCanonFromPins(db, sh, projectId, { readSetting })
    } catch (error) {
      if (!isRefusedRead(error)) return { checked: false, error: refusalOf(error), stage: 'cast canon' }
      verdict = castSyncFailure(verdict, error)
    }
    if (written.length) {
      try {
        project = await sh.getProject(projectId)
      } catch (error) {
        if (isRefusedRead(error)) return refused('project', error)
        return { checked: false, error: refusalOf(error), stage: 'project' }
      }
      verdict = evaluateReadiness({ project, credits, publishing, minCredits })
    }
  }
  return {
    checked: true,
    error: null,
    ...verdict,
    balance: Number.isFinite(Number(credits?.balance)) ? Number(credits.balance) : null,
    publishing,
  }
}

/**
 * The show's readiness as this Worker reads it (the project, the balance, the
 * configured series), healing the cast canon from the D1 `pinnedVoices` first
 * when the cast is not ready. Null when the Worker has no Story API
 * credentials. Both the nightly tick and the community `POST /api/generate`
 * read readiness through here, after the deploy gate.
 */
export async function readShowReadiness(env, { seriesId = null, minCredits = MIN_EPISODE_CREDITS } = {}) {
  if (!env?.SLEEPERHIT_API_KEY || !env?.HNRADIO_PROJECT_ID) return null
  const sh = new SleeperHit({
    baseUrl: env.SLEEPERHIT_API_BASE || 'https://sleeperhit.studio',
    apiKey: env.SLEEPERHIT_API_KEY,
  })
  return readReadiness(sh, {
    projectId: env.HNRADIO_PROJECT_ID,
    seriesId,
    keyId: env.SLEEPERHIT_API_KEY_ID || null,
    minCredits,
    db: env.DB ?? null,
  })
}
