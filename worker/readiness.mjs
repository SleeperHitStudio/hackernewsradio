/**
 * The recurring producer's READINESS PREFLIGHT: before the nightly spends
 * anything on an episode, one read of the project and one of the balance say
 * whether an episode can succeed at all.
 *
 *   GET /story-projects/{id}  → project.workspaceGate { ready, stage, reason, canStartEpisode, … }
 *                               project.tableReadReadiness { ready, reason, … } (once the platform reports it)
 *   GET /credits              → credits.balance
 *   GET /publishing-series/{id} → the series' standing approval (publishing only)
 *
 * Each field is read only when the platform returns it, so the preflight works
 * against a platform that has not shipped a field yet and tightens the moment
 * it does. Everything here is pure except `readReadiness`, which takes the
 * client as an argument.
 */

/** A table read (~20) plus its audio finalize (6): what one episode costs. */
export const MIN_EPISODE_CREDITS = 26

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function sentence(value, fallback) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text || fallback
}

/**
 * Whether the project can start an episode. Returns the FIRST reason it
 * cannot, as one of the readiness failure classes, or `ready: true`.
 */
export function evaluateReadiness({ project, credits, minCredits = MIN_EPISODE_CREDITS } = {}) {
  const gate = isRecord(project?.workspaceGate) ? project.workspaceGate : null
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
    }
  }

  const tableRead = isRecord(project?.tableReadReadiness) ? project.tableReadReadiness : null
  if (tableRead && (tableRead.ready === false || tableRead.canStart === false)) {
    const missing = [tableRead.missingVoices, tableRead.uncast, tableRead.missing]
      .find((value) => Array.isArray(value))
    return {
      ready: false,
      failureClass: 'cast_not_ready',
      code: 'cast_precondition_failed',
      message: `HNRadio cannot start a table read: ${sentence(tableRead.reason, 'the cast canon does not voice every character.')}`,
      details: { missing: missing ? missing.map(String) : [] },
    }
  }

  const balance = Number(credits?.balance)
  if (credits && Number.isFinite(balance) && balance < minCredits) {
    return {
      ready: false,
      failureClass: 'quota',
      code: 'insufficient_credits',
      message: `Not enough Studio Credits for an episode: the balance is ${balance}, one episode needs ${minCredits}. Top up to resume the show.`,
      details: { balance, required: minCredits },
    }
  }

  return { ready: true, failureClass: null, code: null, message: null, details: null }
}

/**
 * The series' standing approval, as the platform reports it. `known` is false
 * while the platform does not report the field at all; `granted` is true only
 * when the grant is bound to an API key (and, when HNR knows its own key id,
 * to THAT key).
 */
export function standingApprovalOf(series, { keyId = null } = {}) {
  if (!isRecord(series)) return { known: false, granted: false, keyId: null, grantedAt: null }
  const nested = isRecord(series.standingApproval) ? series.standingApproval : null
  const known = 'standingApproval' in series || 'standingApprovalKeyId' in series
  const grantKeyId = nested?.keyId ?? series.standingApprovalKeyId ?? null
  const grantedAt = nested?.grantedAt ?? series.standingApprovalGrantedAt ?? null
  const revoked = nested?.revokedAt != null || nested?.active === false
  const boundHere = !keyId || !grantKeyId || grantKeyId === keyId
  return {
    known,
    granted: Boolean(known && grantKeyId && !revoked && boundHere),
    keyId: grantKeyId,
    grantedAt: typeof grantedAt === 'string' ? grantedAt : null,
    boundElsewhere: Boolean(grantKeyId && keyId && grantKeyId !== keyId),
  }
}

/**
 * Whether HNR may publish to the series, WITHOUT asserting a human
 * confirmation. HNR is unattended: it publishes only under the series'
 * standing approval (bound to HNR's key), never by claiming `userConfirmed`.
 * `state` is 'granted', 'blocked' or 'none' (no series configured).
 */
export function publishingReadiness({ seriesId, series, readError = null, keyId = null } = {}) {
  if (!seriesId) return { state: 'none', code: null, reason: null, approval: null }
  if (readError) {
    return {
      state: 'blocked',
      code: readError.code || 'series_unreadable',
      reason: `The HNR publishing series could not be read (${readError.message || readError}).`,
      approval: null,
    }
  }
  const approval = standingApprovalOf(series, { keyId })
  if (!approval.known) {
    return {
      state: 'blocked',
      code: 'standing_approval_unavailable',
      reason: 'The platform does not report a standing approval for the HNR series yet; episodes stay on hnradio.net and publish once the grant exists.',
      approval,
    }
  }
  if (approval.boundElsewhere) {
    return {
      state: 'blocked',
      code: 'standing_approval_other_key',
      reason: 'The HNR series\' standing approval is bound to a different API key; re-grant it to HNR\'s key on the Publishing tab.',
      approval,
    }
  }
  if (!approval.granted) {
    return {
      state: 'blocked',
      code: 'standing_approval_missing',
      reason: 'The HNR series has no standing approval; grant it to HNR\'s key on the Publishing tab to publish unattended.',
      approval,
    }
  }
  return { state: 'granted', code: null, reason: null, approval }
}

/**
 * The idempotency prefix for an episode's release/description/publish calls.
 * Scoped to the grant: a release is covered by the standing approval only when
 * it is created AFTER the grant, so a re-grant starts a fresh release rather
 * than replaying one created (and refused, or cancelled) before it.
 */
export function publishKeyPrefix(dramaId, approval) {
  const grantedMs = Date.parse(approval?.grantedAt ?? '')
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
 * Perform the preflight reads. Never throws: a read that fails is reported as
 * `error` so the caller decides (a failed project or credit read skips the
 * tick's generation; it is not evidence the project is broken).
 */
export async function readReadiness(sh, { projectId, seriesId = null, keyId = null, minCredits = MIN_EPISODE_CREDITS } = {}) {
  let project = null
  let credits = null
  try {
    project = await sh.getProject(projectId)
  } catch (error) {
    return { checked: false, error: refusalOf(error), stage: 'project' }
  }
  try {
    credits = await sh.getCredits()
  } catch (error) {
    return { checked: false, error: refusalOf(error), stage: 'credits' }
  }
  let series = null
  let seriesError = null
  if (seriesId) {
    try {
      series = await sh.getPublishingSeries(seriesId)
    } catch (error) {
      seriesError = refusalOf(error)
    }
  }
  return {
    checked: true,
    error: null,
    ...evaluateReadiness({ project, credits, minCredits }),
    balance: Number.isFinite(Number(credits?.balance)) ? Number(credits.balance) : null,
    publishing: publishingReadiness({ seriesId, series, readError: seriesError, keyId }),
  }
}
