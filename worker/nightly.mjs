import {
  buildSourceMetadata,
  fetchArticle,
  fetchThread,
  threadToTranscript,
  verifiedSourceProgress,
} from './hn.mjs'
import {
  appendProgress,
  deleteDrama,
  deleteOtherEpisodesOfThread,
  findByHnIdAndMode,
  getDrama,
  getSetting,
  patchDrama,
  setSetting,
  upsertDrama,
} from './store.mjs'
import {
  classifySystemicFailure,
  isAccessFailure,
  isApprovalMissingFailure,
  isCastNotReadyFailure,
  isContractClassFailure,
  isProjectNotReadyFailure,
  isProviderBlockedFailure,
  isProviderQuotaFailure,
  isQuotaClassFailure,
  isReadinessClass,
  isSystemicClass,
  isTransientSourceFailure,
} from './failure-classification.mjs'
import {
  WORKFLOW_DEPLOY_GATE_KEY,
  activeWorkflowDeployGate,
} from './deploy-gate.mjs'
import { alertsConfigured, sendOperatorAlert } from './alerts.mjs'
import { PUBLISHED_PROGRESS_MESSAGE, isPublishedToFeed, needsPublishOnly } from './publishing.mjs'
import { MIN_EPISODE_CREDITS, accessFailure, approvalFailure, isRefusedRead, readShowReadiness } from './readiness.mjs'

export {
  CONTRACT_CLASS_RE,
  PLATFORM_CREDITS_RE,
  PROVIDER_BLOCK_RE,
  PROVIDER_QUOTA_RE,
  classifySystemicFailure,
  isContractClassFailure,
  isProviderBlockedFailure,
  isProviderQuotaFailure,
  isQuotaClassFailure,
  isTransientSourceFailure,
} from './failure-classification.mjs'
export { PUBLISHED_PROGRESS_MESSAGE } from './publishing.mjs'

export const NIGHTLY_TARGET = 5
export const NIGHTLY_MAX_ATTEMPTS = 3
// Free retries for a thread whose search index has not caught up. Capped so a
// thread that never converges still exhausts instead of holding a slot all night.
export const NIGHTLY_MAX_SOURCE_LAG_HOLDS = 3
export const NIGHTLY_MUSIC_STALL_TIMEOUT_MS = 60 * 60 * 1000
export const NIGHTLY_MUSIC_RECOVERY_COOLDOWN_MS = 60 * 60 * 1000
export const NIGHTLY_MUSIC_RECOVERY_MAX_ACTIONS = 2
export const NIGHTLY_SYSTEMIC_PROBE_COOLDOWN_MS = 60 * 60 * 1000
export const NIGHTLY_GENERATION_CIRCUIT_KEY = 'nightlyGenerationCircuit'
// When the readiness preflight last SAW each readiness class failing. A passing
// read clears an episode's failure only when the read saw that condition after
// the episode failed; otherwise the read cannot see what stopped it.
export const NIGHTLY_READINESS_LEDGER_KEY = 'nightlyReadinessLedger'
// Publish-only retries back off from one hour to a day. They cost no credits,
// but a feed that refuses on state refuses the same way until the state moves.
export const NIGHTLY_PUBLISH_RETRY_BASE_MS = 60 * 60 * 1000
export const NIGHTLY_PUBLISH_RETRY_MAX_MS = 24 * 60 * 60 * 1000
// How long a superseded night keeps draining for an episode the feed has not
// taken. The episode stays on hnradio.net either way; this only bounds how many
// old batches every hourly tick walks while publishing is blocked.
export const NIGHTLY_PUBLISH_HOLD_DAYS = 14

const MUSIC_WRITE_BUDGET_CHECKPOINT = Object.freeze({
  name: 'music write budget break',
  type: 'sleep',
})

const MUSIC_WATCHDOG_RESTART_MESSAGE =
  'Watchdog: post-production stopped waking after the music budget break; restarting from that checkpoint.'
const MUSIC_WATCHDOG_RESUME_MESSAGE =
  'Watchdog: the music wake stalled again; restarting post-production on the existing performance.'

const ACTIVE_WORKFLOW_STATUSES = new Set(['queued', 'running', 'waiting', 'waitingforpause', 'paused'])

// One full first-wave wipeout (five stories, zero published) is alertable.
export const ALERT_MIN_FAILURES = 5

const ALERT_SUBJECTS = {
  contract: 'blocked by a contract/validation error — needs a fix, retries cannot help',
  access: 'blocked: the Story API refuses HNR\'s key or project',
  project_not_ready: 'blocked: the HNRadio project has not finished a development stage',
  approval_missing: 'blocked: no standing approval covers HNR\'s key — nothing is spent',
  cast_not_ready: 'blocked: the cast canon cannot voice a table read',
  provider: 'blocked by a provider policy throttle',
  provider_quota: 'blocked by a provider quota cliff',
  quota: 'blocked: out of Studio Credits',
  failing: 'is failing repeatedly',
}

const ALERT_FOOTERS = {
  contract: 'The platform is REJECTING our requests (schema/validation). This is deterministic. The global generation circuit is open and permits only one hourly recovery probe until a fix deploys.',
  access: 'The Story API refused HNR\'s own reads (401/403/404): the API key was revoked, rotated or lost a scope, or HNRADIO_PROJECT_ID names a project that is gone. Fix SLEEPERHIT_API_KEY or the project id. The generation circuit is open; each hour it re-reads (free) and resumes when the read succeeds.',
  project_not_ready: 'Sleeper Hit refuses episodes until the HNRadio project finishes the stage named above (its workspace gate). No retry can pass it. The generation circuit is open; each hour it re-reads the project (free, read-only) and resumes the moment the stage is done.',
  approval_missing: 'HNR runs unattended, so it uploads, plans, approves, buys and publishes ONLY under the publishing series\' standing approval bound to its own API key (SLEEPERHIT_API_KEY_ID). Grant it on the Publishing tab (or re-grant it to HNR\'s key). Nothing is spent meanwhile; finished episodes stay on hnradio.net. The generation circuit is open; each hour it re-reads the series (free) and resumes once the grant covers HNR.',
  cast_not_ready: 'Sleeper Hit cannot voice a table read: a character in the roster has no voice in the project cast canon. Pin the voice in the cast canon. The generation circuit is open; while readiness is measurable each hour re-reads it (free), otherwise one episode probes it.',
  provider: 'The configured writer/planner provider is policy-throttling requests. The global generation circuit is open and permits only one hourly recovery probe; provider failover or the reset window must clear it.',
  provider_quota: 'A provider behind Sleeper Hit (writer, planner, voice) hit a quota, billing or rate cliff. The Studio Credit balance cannot see it, so the global generation circuit is open and permits one hourly recovery probe (the stopped episode) until the provider is funded or rebound.',
  quota: 'Out of Studio Credits. The global generation circuit is open; each hour it re-reads the Studio Credit balance (free) instead of building an episode, and resumes — re-sending the same job request — once a top-up covers the episode.',
  failing: 'Repeated failures with nothing published tonight. Check the episode progress logs on hnradio.net/api/dramas?includeFailed=true.',
}

// Which batch flag marks an item blocked by each class (the distress alert reads them).
const BLOCKED_AT_FIELD = {
  provider: 'providerBlockedAt',
  provider_quota: 'providerQuotaBlockedAt',
  quota: 'quotaBlockedAt',
  contract: 'contractBlockedAt',
  access: 'accessBlockedAt',
  project_not_ready: 'projectBlockedAt',
  approval_missing: 'approvalBlockedAt',
  cast_not_ready: 'castBlockedAt',
}

/**
 * Email the operator when a batch is in distress: a contract/validation
 * rejection (immediately — deterministic, retries cannot fix it), a
 * quota-class failure (needs a top-up or rebind), or a pile-up of ordinary
 * failures with nothing published (cumulative `failureEvents`, so a full
 * first-wave wipeout alerts on the very next tick). One email per batch date
 * per distress type; the hourly cron would otherwise spam.
 */
export async function maybeSendDistressAlert(env, batch, deps) {
  if (!alertsConfigured(env)) return null

  const recentErrors = [
    ...(batch.errors ?? []).map((entry) => entry.message),
    ...(batch.items ?? []).map((item) => item.lastError),
  ].filter(Boolean)
  const flagged = (field, predicate) => (batch.items ?? []).some((item) => item[field])
    || recentErrors.some((message) => predicate(message))
  const published = (batch.items ?? []).filter((item) => item.status === 'published').length

  let type = null
  if (flagged('contractBlockedAt', isContractClassFailure)) type = 'contract'
  else if (flagged('accessBlockedAt', isAccessFailure)) type = 'access'
  else if (flagged('projectBlockedAt', isProjectNotReadyFailure)) type = 'project_not_ready'
  else if (flagged('approvalBlockedAt', isApprovalMissingFailure)) type = 'approval_missing'
  else if (flagged('castBlockedAt', isCastNotReadyFailure)) type = 'cast_not_ready'
  else if (flagged('providerBlockedAt', isProviderBlockedFailure)) type = 'provider'
  else if (flagged('providerQuotaBlockedAt', isProviderQuotaFailure)) type = 'provider_quota'
  else if (flagged('quotaBlockedAt', isQuotaClassFailure)) type = 'quota'
  else if (published === 0 && Number(batch.failureEvents || 0) >= ALERT_MIN_FAILURES) type = 'failing'
  if (!type) return null

  // The readiness preflight already emailed this outage (once per class).
  const circuit = await deps.getSetting(env.DB, NIGHTLY_GENERATION_CIRCUIT_KEY)
  if (circuit?.state === 'open' && circuit.alertedClass === type) return null

  const sentKey = `distressAlert:${batch.date}:${type}`
  if (await deps.getSetting(env.DB, sentKey)) return null

  const lines = [
    `hnradio nightly batch ${batch.date} is in distress (${type}).`,
    `Published so far: ${published}/${batch.target ?? NIGHTLY_TARGET}.`,
    '',
    ...(batch.items ?? []).map((item) =>
      `- [${item.status}] HN ${item.hnId} "${item.title}"${item.lastError ? ` — ${item.lastError}` : ''}`),
    '',
    'Recent batch errors:',
    ...(batch.errors ?? []).slice(-5).map((entry) => `- ${entry.at}: ${entry.message}`),
    '',
    ALERT_FOOTERS[type],
  ]

  const sent = await sendOperatorAlert(env, {
    subject: `[hnradio] nightly ${batch.date} ${ALERT_SUBJECTS[type]}`,
    lines,
  })
  if (!sent) return null
  await deps.setSetting(env.DB, sentKey, nowIso())
  return type
}

const defaultDependencies = {
  appendProgress,
  deleteDrama,
  deleteOtherEpisodesOfThread,
  findByHnIdAndMode,
  getDrama,
  getSetting,
  patchDrama,
  setSetting,
  upsertDrama,
  fetchArticle,
  fetchThread,
  // The project's workspace gate and table-read readiness, the credit balance,
  // and the publishing series' standing approval. Null without credentials.
  readReadiness: readShowReadiness,
  now: () => new Date(),
  randomUUID: () => crypto.randomUUID(),
  async fetchJson(url) {
    const response = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!response.ok) throw new Error(`Hacker News returned ${response.status} for ${url}`)
    return response.json()
  },
}

export function centralRunContext(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    hour12: false,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
  }).formatToParts(now)
  const get = (type) => parts.find((part) => part.type === type)?.value
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')),
  }
}

export const nightlyBatchKey = (date) => `dailyTopBatch:${date}`

export function isActiveWorkflowStatus(status) {
  return ACTIVE_WORKFLOW_STATUSES.has(String(status || '').toLowerCase())
}

export function hasPublishedProgress(drama) {
  return (drama?.progress ?? []).some((entry) => entry?.message === PUBLISHED_PROGRESS_MESSAGE)
}

export function isPublishedEpisode(drama) {
  return drama?.status === 'ready' && Boolean(drama?.audioUrl) && isPublishedToFeed(drama)
}

export function activeBatchItems(batch) {
  // Published items still occupy one of the five promised slots; only an
  // exhausted/superseded item is replaced by a lower-ranked candidate.
  return (batch?.items ?? []).filter(
    (item) => !['exhausted', 'superseded'].includes(item.status),
  )
}

const nowIso = () => new Date().toISOString()

function dependencyNow(deps) {
  const value = deps.now?.() ?? new Date()
  const date = value instanceof Date ? value : new Date(value)
  return Number.isFinite(date.getTime()) ? date : new Date()
}

function openCircuitValue(value) {
  return value?.state === 'open' ? value : null
}

async function loadGenerationController(env, deps) {
  const circuit = openCircuitValue(
    await deps.getSetting(env.DB, NIGHTLY_GENERATION_CIRCUIT_KEY),
  )
  const ledger = await deps.getSetting(env.DB, NIGHTLY_READINESS_LEDGER_KEY)
  return {
    circuit,
    ledger: ledger && typeof ledger === 'object' ? ledger : { failedReads: {} },
    // A successful probe closes the persisted circuit immediately, but this
    // invocation remains restricted. The following hourly tick can then refill
    // normally without a single success releasing a same-tick fan-out.
    restrictedForRun: Boolean(circuit),
    // Starting/resuming pre-artifact work is globally serialized even while
    // the circuit is closed. Existing active work and artifact recovery do not
    // consume this slot.
    generationStarted: false,
    probeStarted: false,
    probeStatusChecked: false,
    probeStillActive: false,
    // The tick's readiness preflight (see ensureReadiness): read at most once.
    readinessChecked: false,
    readiness: null,
    // True when this Worker has no preflight to run (no Story API credentials):
    // a read-probed circuit then falls back to an episode probe.
    noPreflight: false,
  }
}

/**
 * How a circuit is probed. A READ circuit (opened by a failing preflight read)
 * is probed by that free read and closed only by a passing one; an EPISODE
 * circuit is probed by resuming one stopped episode and closed only when that
 * episode produces a performance.
 */
function isReadProbed(controller, circuit = controller.circuit) {
  return circuit?.probe === 'read' && !controller.noPreflight
}

/** Remember that the preflight saw `failureClass` failing just now. */
async function recordFailingRead(env, controller, deps, failureClass, at) {
  const ledger = {
    ...(controller.ledger ?? {}),
    failedReads: { ...(controller.ledger?.failedReads ?? {}), [failureClass]: at },
  }
  controller.ledger = ledger
  await deps.setSetting(env.DB, NIGHTLY_READINESS_LEDGER_KEY, ledger)
}

function readinessAlertLines(batch, circuit) {
  const details = circuit.readiness?.details ?? {}
  return [
    `hnradio cannot start episodes (${circuit.failureClass}). Nothing was spent: the readiness preflight caught it before any upload, plan, or job.`,
    '',
    circuit.failureMessage,
    ...(details.stage ? [`Stage: ${details.stage}${details.missingFields?.length ? ` (missing: ${details.missingFields.join(', ')})` : ''}`] : []),
    ...(details.missing?.length ? [`Unvoiced: ${details.missing.join(', ')}`] : []),
    ...(Number.isFinite(Number(details.balance)) ? [`Balance: ${details.balance} (an episode needs ${details.required}).`] : []),
    ...(details.status ? [`Refused read: ${details.stage} (${details.status}${details.code ? ` ${details.code}` : ''}).`] : []),
    '',
    `Batch ${batch.date}. ${ALERT_FOOTERS[circuit.failureClass] ?? ''}`,
    'This email is sent once per outage.',
  ]
}

/**
 * Open (or keep open) the generation circuit on a readiness failure, and email
 * the operator ONCE per class per outage. Nothing was spent to learn this.
 */
async function openReadinessCircuit(env, controller, deps, { batch, readiness }) {
  const now = dependencyNow(deps)
  const current = controller.circuit
  await recordFailingRead(env, controller, deps, readiness.failureClass, now.toISOString())
  const circuit = {
    ...(current ?? {}),
    state: 'open',
    probe: 'read',
    failureClass: readiness.failureClass,
    failureCode: readiness.code,
    failureMessage: readiness.message,
    readiness: {
      details: readiness.details ?? null,
      checkedAt: now.toISOString(),
    },
    openedAt: current?.openedAt ?? now.toISOString(),
    updatedAt: now.toISOString(),
    lastFailureAt: now.toISOString(),
    lastFailureBatchDate: batch.date,
    // An episode probe from an earlier episode circuit is not this circuit's.
    ...(current?.probe === 'read' ? {} : { probeEpisodeId: null, probeWorkflowId: null }),
    // The check just ran; on an already-open circuit it IS this hour's probe.
    lastProbeAt: current ? now.toISOString() : null,
    probeCount: current ? Number(current.probeCount || 0) + 1 : 0,
    nextProbeAt: new Date(now.getTime() + NIGHTLY_SYSTEMIC_PROBE_COOLDOWN_MS).toISOString(),
  }
  await saveGenerationCircuit(env, controller, circuit, deps)
  if (circuit.alertedClass !== readiness.failureClass) {
    const sent = await sendOperatorAlert(env, {
      subject: `[hnradio] ${ALERT_SUBJECTS[readiness.failureClass] ?? `blocked (${readiness.failureClass})`}`,
      lines: readinessAlertLines(batch, circuit),
    })
    if (sent) {
      await saveGenerationCircuit(env, controller, {
        ...circuit,
        alertedClass: readiness.failureClass,
        alertedAt: now.toISOString(),
      }, deps)
    }
  }
  return controller.circuit
}

/**
 * THE READINESS PREFLIGHT, once per tick, before anything is fetched, uploaded,
 * planned, or bought. The project's workspace gate, its table-read readiness,
 * and a balance that covers one episode must all hold; when one does not, the
 * circuit opens with that class and the operator is told once.
 *
 * The preflight is also the PROBE for readiness-class circuits (project not
 * ready, cast not ready, out of credits): an hourly read, never another paid
 * episode. When it passes, such a circuit closes and this tick may start its
 * one serialized generation — typically the episode the outage stopped.
 *
 * A read the Story API REFUSED (401/403/404) is a failure like any other: an
 * `access` circuit, one email. A read that could not be MADE (network, 5xx,
 * 429) is not evidence of anything: it skips this tick's generation, records a
 * batch error, and changes no circuit.
 */
async function ensureReadiness(env, controller, deps, batch) {
  if (controller.readinessChecked) return controller.readiness
  controller.readinessChecked = true
  const circuit = controller.circuit
  if (circuit) {
    // An open circuit that is not due permits no generation this tick, so a
    // read could not change anything.
    const nextProbeMs = Date.parse(circuit.nextProbeAt)
    if (Number.isFinite(nextProbeMs) && dependencyNow(deps).getTime() < nextProbeMs) return null
  }
  if (typeof deps.readReadiness !== 'function') return null
  const seriesId = await deps.getSetting(env.DB, 'publishingSeriesId')
  // A job the platform refused for credits names what IT costs; the read waits
  // for a balance that covers that, not just the typical episode.
  const floor = circuit?.failureClass === 'quota' ? Number(circuit.readiness?.details?.required) : NaN
  const minCredits = Math.max(MIN_EPISODE_CREDITS, Number.isFinite(floor) ? floor : 0)
  let readiness
  try {
    readiness = await deps.readReadiness(env, { seriesId, minCredits })
  } catch (error) {
    readiness = { checked: false, stage: 'preflight', error: { message: error?.message || String(error) } }
  }
  if (!readiness) {
    controller.noPreflight = true
    controller.readiness = null
    return null
  }
  // A read the API refused is never "could not read": whoever reports it.
  if (!readiness.checked && isRefusedRead(readiness.error)) {
    readiness = accessFailure(readiness.stage || 'project', readiness.error)
  }
  if (readiness.checked && readiness.ready) {
    // The grant is part of readiness: HNR spends nothing it cannot approve.
    const approval = approvalFailure(readiness.publishing)
    if (approval) readiness = { ...readiness, ...approval }
  }
  controller.readiness = readiness
  if (!readiness.checked) {
    controller.readinessUnreadable = true
    recordBatchError(batch, `Readiness preflight could not read the ${readiness.stage || 'project'}: ${readiness.error?.message || 'unknown error'}`)
    return readiness
  }
  if (!readiness.ready) {
    await openReadinessCircuit(env, controller, deps, { batch, readiness })
    return readiness
  }
  if (isReadProbed(controller, circuit)) {
    controller.circuit = null
    controller.restrictedForRun = false
    await deps.setSetting(env.DB, NIGHTLY_GENERATION_CIRCUIT_KEY, null)
  }
  return readiness
}

/**
 * A read-probed circuit cannot grant anything this tick: its probe was the
 * preflight read (already done), or it is not due. Selection must not even
 * fetch a thread then — the point of reading readiness first is that nothing
 * is fetched, uploaded, or bought for an episode that cannot start.
 */
function readinessCircuitHolds(controller) {
  return isReadProbed(controller)
}

function generationSelectionBlocked(controller) {
  // An open circuit must still be allowed to reach acquireGenerationSlot(),
  // which is the single authority for due/active probe decisions. Once a
  // successful probe closes the circuit, restrictedForRun remains true and
  // this helper prevents a same-invocation refill fan-out.
  if (controller.readinessUnreadable) return true
  return controller.restrictedForRun && !controller.circuit
}

async function saveGenerationCircuit(env, controller, circuit, deps) {
  controller.circuit = circuit
  controller.restrictedForRun = true
  await deps.setSetting(env.DB, NIGHTLY_GENERATION_CIRCUIT_KEY, circuit)
}

function probeMatches(circuit, item, drama) {
  if (!circuit) return false
  return (
    (circuit.probeEpisodeId && circuit.probeEpisodeId === (drama?.id || item?.episodeId))
    || (circuit.probeWorkflowId && circuit.probeWorkflowId === item?.workflowId)
  )
}

async function openGenerationCircuit(env, controller, deps, {
  batch,
  item,
  drama,
  failureClass,
  message,
}) {
  const now = dependencyNow(deps)
  const current = controller.circuit
  const failedProbe = probeMatches(current, item, drama)
  const lastProbeAtMs = Date.parse(current?.lastProbeAt)
  const lastProbeFailureAtMs = Date.parse(current?.lastProbeFailureAt)
  const failedProbeAlreadyRecorded = failedProbe
    && Number.isFinite(lastProbeAtMs)
    && Number.isFinite(lastProbeFailureAtMs)
    && lastProbeFailureAtMs >= lastProbeAtMs
  const resetProbeWindow = !current
    || (failedProbe && !failedProbeAlreadyRecorded)
    || !Number.isFinite(Date.parse(current.nextProbeAt))
  const circuit = {
    ...(current ?? {}),
    state: 'open',
    probe: 'episode',
    failureClass,
    failureMessage: String(message || 'Nightly generation is systemically blocked.'),
    openedAt: current?.openedAt ?? now.toISOString(),
    updatedAt: now.toISOString(),
    nextProbeAt: resetProbeWindow
      ? new Date(now.getTime() + NIGHTLY_SYSTEMIC_PROBE_COOLDOWN_MS).toISOString()
      : current.nextProbeAt,
    lastFailureAt: now.toISOString(),
    lastFailureBatchDate: batch.date,
    lastFailureHnId: item.hnId,
    lastFailureEpisodeId: drama?.id || item.episodeId || null,
    ...(failedProbe && !failedProbeAlreadyRecorded ? {
      lastProbeFailureAt: now.toISOString(),
      lastProbeFailureEpisodeId: drama?.id || item.episodeId || null,
    } : {}),
  }
  await saveGenerationCircuit(env, controller, circuit, deps)
  return circuit
}

async function acquireGenerationSlot(env, controller, deps, {
  batch,
  item,
}) {
  // A preflight that could not read the project is not permission to spend.
  if (controller.readinessUnreadable) return { allowed: false, probe: false }
  const circuit = controller.circuit
  // A read-probed circuit is probed by the preflight read, never by an
  // episode — except when this Worker has no preflight to run.
  if (isReadProbed(controller)) return { allowed: false, probe: false }
  if (!circuit) {
    if (controller.restrictedForRun || controller.generationStarted) {
      return { allowed: false, probe: false }
    }
    controller.generationStarted = true
    return { allowed: true, probe: false }
  }
  if (controller.probeStarted) return { allowed: false, probe: false }

  const now = dependencyNow(deps)
  const nextProbeMs = Date.parse(circuit.nextProbeAt)
  if (Number.isFinite(nextProbeMs) && now.getTime() < nextProbeMs) {
    return { allowed: false, probe: false }
  }
  if (!controller.probeStatusChecked && circuit.probeWorkflowId) {
    controller.probeStatusChecked = true
    try {
      const { status } = await workflowState(env, circuit.probeWorkflowId)
      controller.probeStillActive = isActiveWorkflowStatus(status)
    } catch (error) {
      // A missing/expired Workflow is not active and may be replaced by the
      // due probe. Other inspection failures are retried on the next tick.
      controller.probeStillActive = !/not found|does not exist|unknown instance/i
        .test(error?.message || String(error))
    }
  }
  if (controller.probeStillActive) return { allowed: false, probe: false }

  controller.probeStarted = true
  controller.generationStarted = true
  const reserved = {
    ...circuit,
    updatedAt: now.toISOString(),
    lastProbeAt: now.toISOString(),
    nextProbeAt: new Date(now.getTime() + NIGHTLY_SYSTEMIC_PROBE_COOLDOWN_MS).toISOString(),
    probeCount: Number(circuit.probeCount || 0) + 1,
    probeBatchDate: batch.date,
    probeHnId: item.hnId,
    probeEpisodeId: item.episodeId || null,
    probeWorkflowId: null,
  }
  await saveGenerationCircuit(env, controller, reserved, deps)
  return { allowed: true, probe: true }
}

async function recordGenerationProbe(env, controller, deps, {
  batch,
  item,
}) {
  if (!controller.circuit) return
  await saveGenerationCircuit(env, controller, {
    ...controller.circuit,
    updatedAt: dependencyNow(deps).toISOString(),
    probeBatchDate: batch.date,
    probeHnId: item.hnId,
    probeEpisodeId: item.episodeId || null,
    probeWorkflowId: item.workflowId || null,
  }, deps)
}

async function closeGenerationCircuitForProbe(env, controller, deps, item, drama) {
  // A read-probed circuit closes on a passing read, never on an old episode.
  if (isReadProbed(controller)) return false
  if (!probeMatches(controller.circuit, item, drama)) return false
  controller.circuit = null
  controller.restrictedForRun = true
  await deps.setSetting(env.DB, NIGHTLY_GENERATION_CIRCUIT_KEY, null)
  return true
}

function latestEpisodeProgressMs(drama) {
  const timestamps = (drama?.progress ?? [])
    .map((entry) => Date.parse(entry?.at))
    .filter(Number.isFinite)
  return timestamps.length ? Math.max(...timestamps) : null
}

function isMissingWorkflowCheckpoint(error) {
  return /(?:no|could not find)[^.]*step|step[^.]*(?:not found|does not exist)|matching[^.]*step[^.]*not found/i
    .test(error?.message || String(error))
}

function watchdogStateFor(item, artifactId) {
  const current = item.musicWatchdog
  if (!current || current.artifactId !== artifactId) {
    return { artifactId, recoveryCount: 0 }
  }
  return current
}

function recordBatchError(batch, message) {
  batch.errors = [...(batch.errors ?? []), { at: nowIso(), message: String(message) }].slice(-20)
}

async function persistBatch(db, batch, deps) {
  batch.updatedAt = nowIso()
  await deps.setSetting(db, nightlyBatchKey(batch.date), batch)
}

async function workflowState(env, workflowId) {
  const instance = await env.PIPELINE.get(workflowId)
  return {
    instance,
    status: (await instance.status())?.status || 'unknown',
  }
}

async function appendWatchdogProgress(env, batch, drama, deps, message, eventKey, runId) {
  await deps.appendProgress(env.DB, drama.id, message, {
    runId: runId || `nightly:${batch.date}:music-watchdog`,
    eventKey,
  })
}

async function recoverStalledMusicWake(env, batch, item, drama, instance, deps) {
  if (!drama?.artifactId || !instance) return false

  const now = dependencyNow(deps)
  const nowMs = now.getTime()
  const watchdog = watchdogStateFor(item, drama.artifactId)
  item.musicWatchdog = watchdog
  watchdog.artifactObservedAt ??= now.toISOString()
  const lastProgressMs = latestEpisodeProgressMs(drama) ?? Date.parse(watchdog.artifactObservedAt)
  if (!Number.isFinite(lastProgressMs) || nowMs - lastProgressMs < NIGHTLY_MUSIC_STALL_TIMEOUT_MS) return false

  const lastAttemptMs = Date.parse(watchdog.lastAttemptAt)
  if (Number.isFinite(lastAttemptMs) && nowMs - lastAttemptMs < NIGHTLY_MUSIC_RECOVERY_COOLDOWN_MS) {
    return false
  }

  const recoveryCount = Number(watchdog.recoveryCount || 0)
  if (recoveryCount >= NIGHTLY_MUSIC_RECOVERY_MAX_ACTIONS) {
    watchdog.exhaustedAt ??= now.toISOString()
    item.lastError = `Music wake watchdog exhausted after ${recoveryCount} recovery actions.`
    return false
  }

  watchdog.lastAttemptAt = now.toISOString()
  watchdog.lastObservedProgressAt = new Date(lastProgressMs).toISOString()

  if (recoveryCount === 0) {
    try {
      await instance.restart({ from: MUSIC_WRITE_BUDGET_CHECKPOINT })
    } catch (error) {
      if (!isMissingWorkflowCheckpoint(error)) throw error
      // The Workflow is legitimately still upstream of the checkpoint. Record
      // the probe so the hourly cron cannot hammer restart(), but do not consume
      // a recovery action or replace the active instance.
      watchdog.lastCheckpointMissAt = now.toISOString()
      watchdog.lastCheckpointError = error?.message || String(error)
      item.updatedAt = now.toISOString()
      return false
    }

    watchdog.recoveryCount = 1
    watchdog.lastRecoveryAt = now.toISOString()
    watchdog.lastAction = 'checkpoint-restart'
    delete watchdog.lastCheckpointError
    item.lastError = null
    item.updatedAt = now.toISOString()
    await appendWatchdogProgress(
      env,
      batch,
      drama,
      deps,
      MUSIC_WATCHDOG_RESTART_MESSAGE,
      'music-watchdog-checkpoint-restart',
      item.workflowId,
    )
    return true
  }

  // A second stale interval proves that restarting the completed sleep did not
  // wake this instance. Stop it before starting a fresh resume Workflow so two
  // post-production writers can never race. Resume mode reuses the same
  // artifact, skips generation/casting spend, reruns required autotune/music,
  // and takes the normal first-publish path with stable publication keys.
  const oldWorkflowId = item.workflowId
  const resumeRunId = deps.randomUUID()
  await instance.terminate()
  const resumed = await env.PIPELINE.create({
    id: resumeRunId,
    params: {
      dramaId: drama.id,
      url: drama.url,
      resumeArtifactId: drama.artifactId,
      resumeRunId,
      skipPublish: false,
    },
  })

  item.workflowId = resumed?.id || resumeRunId
  item.episodeId = drama.id
  item.status = 'queued'
  item.lastWorkflowStatus = 'queued'
  item.lastError = null
  item.updatedAt = now.toISOString()
  watchdog.recoveryCount = recoveryCount + 1
  watchdog.lastRecoveryAt = now.toISOString()
  watchdog.lastAction = 'resume-workflow'
  watchdog.terminatedWorkflowId = oldWorkflowId
  watchdog.resumeWorkflowId = item.workflowId
  await appendWatchdogProgress(
    env,
    batch,
    drama,
    deps,
    MUSIC_WATCHDOG_RESUME_MESSAGE,
    'music-watchdog-resume-workflow',
    resumeRunId,
  )
  return true
}

async function prepareEpisodeSource(thread, deps) {
  thread.article = thread.articleUrl
    ? await deps.fetchArticle(thread.articleUrl)
    : null
  const sourceTranscript = threadToTranscript(thread)
  const sourceMetadata = buildSourceMetadata(thread, sourceTranscript)
  return { thread, sourceMetadata }
}

async function createEpisodeWorkflow(env, preparedSource, {
  batchDate,
  attempt,
  staggerSec = 0,
  sourceRecapture = null,
}, deps) {
  const { thread, sourceMetadata } = preparedSource
  const drama = {
    id: crypto.randomUUID(),
    hnId: String(thread.id),
    mode: 'podcast',
    url: thread.url,
    title: thread.title,
    commentCount: thread.total,
    points: thread.points ?? null,
    status: 'queued',
    progress: [{
      at: nowIso(),
      message: verifiedSourceProgress(thread),
      runId: `nightly:${batchDate}:attempt:${attempt}`,
      eventKey: 'source-completeness-verified',
    }],
    sourceCompleteness: sourceMetadata.sourceCompleteness,
    audioUrl: null,
    error: null,
    createdAt: nowIso(),
    nightlyBatchDate: batchDate,
    nightlyAttempt: attempt,
  }
  await deps.upsertDrama(env.DB, drama)
  try {
    const instance = await env.PIPELINE.create({
      id: drama.id,
      params: {
        dramaId: drama.id,
        url: thread.url,
        staggerSec,
        ...(sourceRecapture ? { sourceRecapture } : {}),
      },
    })
    return {
      drama,
      workflowId: instance?.id || drama.id,
    }
  } catch (error) {
    await deps.deleteDrama(env.DB, drama.id).catch(() => {})
    throw error
  }
}

async function resumeArtifactWorkflow(env, drama) {
  const workflowId = crypto.randomUUID()
  await env.PIPELINE.create({
    id: workflowId,
    params: {
      dramaId: drama.id,
      url: drama.url,
      resumeArtifactId: drama.artifactId,
      resumeRunId: workflowId,
    },
  })
  return workflowId
}

/**
 * Publish a finished MP3 and do NOTHING else: no post-production, no
 * re-finalize. Both are paid, and re-running them for an episode whose only
 * missing step was the feed is the loop that bought 364 finalizes in a week.
 */
async function publishOnlyWorkflow(env, drama, deps) {
  const workflowId = deps.randomUUID()
  await env.PIPELINE.create({
    id: workflowId,
    params: {
      dramaId: drama.id,
      url: drama.url,
      publishOnly: true,
      publishRunId: workflowId,
    },
  })
  return workflowId
}

function publishHoldActive(batch, deps) {
  const startedMs = Date.parse(`${batch?.date}T00:00:00.000Z`)
  if (!Number.isFinite(startedMs)) return true
  return dependencyNow(deps).getTime() - startedMs < NIGHTLY_PUBLISH_HOLD_DAYS * 24 * 60 * 60 * 1000
}

export function publishRetryDelayMs(attemptsSoFar) {
  const n = Math.max(0, Number(attemptsSoFar) || 0)
  return Math.min(NIGHTLY_PUBLISH_RETRY_MAX_MS, NIGHTLY_PUBLISH_RETRY_BASE_MS * 2 ** n)
}

/**
 * A finished episode the feed has not taken. It holds its batch slot and never
 * exhausts (exhausting would free the slot for ANOTHER paid episode that the
 * same feed would refuse); it retries the publish step alone, backing off.
 */
async function recoverPublication(env, item, drama, deps, generationController) {
  const now = dependencyNow(deps)
  const hold = (reason) => {
    item.status = 'publish_blocked'
    item.lastWorkflowStatus = 'publish_blocked'
    item.episodeId = drama.id
    item.lastError = reason
    item.updatedAt = now.toISOString()
  }
  const publishing = generationController.readiness?.publishing
  if (publishing?.state === 'blocked') {
    hold(publishing.reason || drama.publishError || 'The podcast feed is not accepting HNR episodes.')
    return
  }
  if (publishing?.state === 'none') {
    hold('No publishing series is configured (settings.publishingSeriesId).')
    return
  }
  const retryAtMs = Date.parse(item.publishRetryAt)
  if (Number.isFinite(retryAtMs) && now.getTime() < retryAtMs) {
    hold(drama.publishError || 'Waiting to retry the podcast publish.')
    return
  }
  const attempts = Number(item.publishAttempts || 0)
  item.workflowId = await publishOnlyWorkflow(env, drama, deps)
  item.episodeId = drama.id
  item.publishAttempts = attempts + 1
  item.publishRetryAt = new Date(now.getTime() + publishRetryDelayMs(attempts)).toISOString()
  item.status = 'queued'
  item.lastWorkflowStatus = 'queued'
  item.lastError = null
  item.updatedAt = now.toISOString()
}

/**
 * Whether a failed episode can be recovered by RESUMING its existing plan/job
 * rather than replanning from scratch.
 *
 * The line is whether the PLAN HAS ALREADY GENERATED, and a jobId is how that
 * shows here — a job only exists once its plan was approved.
 *
 * `resumeStoryPlan` on the platform regenerates a plan that has not generated
 * (FAILED/PENDING with no `generatedAt`), which is why resuming after a failure
 * BEFORE job creation is a real recovery: the blueprint is rewritten. But it
 * returns an already-approved plan UNCHANGED, so once a job exists the same
 * blueprint comes back every time.
 *
 * For a contract failure that is fatal. Contract means the platform rejected
 * the blueprint itself — a cast the show cannot voice, a field over a schema
 * cap — so replaying it earns the identical rejection, the hourly probe never
 * succeeds, and the episode is stuck until someone edits the database by hand.
 * That is how one episode held a batch at 1 of 5 with the circuit reopening
 * every hour. Replanning is the only recovery that can change the outcome.
 *
 * Every other class (provider, quota, transient) is a failure AROUND a sound
 * blueprint, so it still resumes — replanning would throw away a paid plan.
 */
export function canResumeGeneration(drama, failureClass, { replan = false } = {}) {
  if (replan) return false
  if (failureClass === 'contract' && drama?.jobId) return false
  return Boolean(drama?.jobId || drama?.planId)
}

async function resumeGenerationWorkflow(env, drama, deps, failureClass = null, { replan = false } = {}) {
  if (!canResumeGeneration(drama, failureClass, { replan })) return null
  const workflowId = deps.randomUUID()
  // A job refused for credits (402) is re-sent under the SAME key from its
  // plan; resuming an older job id here would revive an abandoned take.
  const pendingJob = drama?.pendingJob?.key && drama.pendingJob.planId ? drama.pendingJob : null
  const resource = pendingJob
    ? { resumePlanId: pendingJob.planId, jobKey: pendingJob.key }
    : drama?.jobId
      ? { resumeJobId: drama.jobId }
      : drama?.planId
        ? { resumePlanId: drama.planId }
        : null
  if (!resource) return null
  await env.PIPELINE.create({
    id: workflowId,
    params: {
      dramaId: drama.id,
      url: drama.url,
      ...resource,
      recoveryRunId: workflowId,
    },
  })
  return workflowId
}

/** When the episode failed (the pipeline stamps it; its last progress note otherwise). */
function failureTimeMs(drama, item) {
  const stamped = Date.parse(drama?.failedAt)
  if (Number.isFinite(stamped)) return stamped
  if (drama) return latestEpisodeProgressMs(drama)
  const itemAt = Date.parse(item?.updatedAt)
  return Number.isFinite(itemAt) ? itemAt : null
}

/** What a refused job costs: the typical episode, or more when the 402 said so. */
function creditsRequiredFor(drama) {
  const required = Number(drama?.pendingJob?.required)
  return Math.max(MIN_EPISODE_CREDITS, Number.isFinite(required) ? required : 0)
}

/**
 * What a SYSTEMIC failure means for its item this tick.
 *
 *   'held'    — a read-probed circuit (or an unreadable preflight) holds all
 *               generation; the item waits behind it, and nothing changes.
 *   'cleared' — the preflight MEASURES this condition, SAW it failing after the
 *               episode failed, and now reads it passing: resume, spend nothing.
 *   'short'   — out of Studio Credits for THIS job (its 402 needs more than the
 *               balance): a read-probed quota circuit at that price.
 *   'item'    — the preflight measured the condition as passing around the
 *               failure, so the cause is this episode's own plan (a roster the
 *               cast canon cannot voice, a plan the grant does not cover):
 *               spend the item's attempt, as any per-episode failure does.
 *   'blocked' — the preflight cannot vouch for it (it does not measure it, or
 *               the read and the platform disagree): an episode-probed circuit,
 *               a flag, and the distress alert.
 *
 * A passing read never clears what it cannot see. Before this, any passing
 * read cleared every readiness-class failure — including a cast refusal the
 * read does not measure and a provider quota it cannot see — and the item
 * resumed every hour forever with no circuit, no attempt spent and no email.
 */
function systemicVerdict(controller, failureClass, drama, failureAtMs) {
  if (!failureClass) return null
  if (controller.readinessUnreadable || isReadProbed(controller)) return 'held'
  if (!isReadinessClass(failureClass)) return 'blocked'
  const readiness = controller.readiness
  // No read this tick (no preflight, or an episode circuit that is not due):
  // the episode circuit decides, exactly as for any systemic class.
  if (!(readiness?.checked && readiness.ready)) return 'blocked'
  if (failureClass === 'quota') {
    if (!Number.isFinite(readiness.balance)) return 'blocked'
    return readiness.balance >= creditsRequiredFor(drama) ? 'cleared' : 'short'
  }
  if (!readiness.measured?.includes(failureClass)) return 'blocked'
  const sawFailingMs = Date.parse(controller.ledger?.failedReads?.[failureClass])
  if (Number.isFinite(sawFailingMs) && Number.isFinite(failureAtMs) && sawFailingMs >= failureAtMs) return 'cleared'
  return failureClass === 'cast_not_ready' || failureClass === 'approval_missing' ? 'item' : 'blocked'
}

async function recoverItem(
  env,
  batch,
  item,
  drama,
  deps,
  generationController,
  { allowGeneration = true } = {},
) {
  // The EPISODE is the authority on its own outcome. `item.lastError` is batch
  // bookkeeping that persists across ticks and is only cleared once a recovery
  // completes — so when the slot is denied it never clears, and the next tick
  // reads the same stale string, reclassifies it, and reopens the circuit.
  // That is a closed loop: the circuit stays open because it was open. It kept
  // reopening on a JOHNSMITH1840 message hours after the episode itself had
  // been healed. It is still the fallback when no drama exists, which is the
  // case it was there for — a failure that never reached an episode row.
  const failureMessage = drama
    ? (drama.failureMessage || drama.error || null)
    : item.lastError
  const failureClass = isSystemicClass(drama?.failureClass)
    ? drama.failureClass
    : classifySystemicFailure({
      failureCode: drama?.failureCode,
      failureMessage,
    })
  // Systemic failures never spend the item's attempt budget — unless the
  // preflight shows the cause is this episode's own (see systemicVerdict).
  let verdict = systemicVerdict(generationController, failureClass, drama, failureTimeMs(drama, item))
  if (verdict === 'short') {
    const balance = generationController.readiness.balance
    const required = creditsRequiredFor(drama)
    await openReadinessCircuit(env, generationController, deps, {
      batch,
      readiness: {
        failureClass: 'quota',
        code: 'insufficient_credits',
        message: `Not enough Studio Credits for the stopped episode: the balance is ${balance}, its job needs ${required}. Top up to resume the show.`,
        details: { balance, required },
      },
    })
    verdict = 'held'
  }
  const systemic = verdict !== null && verdict !== 'item'
  const blocked = verdict === 'blocked'
  // A plan whose roster the canon cannot voice earns the same refusal every
  // time it is resumed; only a fresh plan can cast differently.
  const replan = verdict === 'item' && failureClass === 'cast_not_ready'
  if (blocked && BLOCKED_AT_FIELD[failureClass]) item[BLOCKED_AT_FIELD[failureClass]] = nowIso()

  // A thread whose index has not caught up costs the item nothing for the first
  // few ticks: it is expected to settle within minutes, and spending a third of
  // a three-attempt budget on it would drop the story for the night. The hold
  // is capped so a thread that never converges still exhausts normally.
  const lagHolds = Number(item.sourceLagHolds || 0)
  const heldForSourceLag = !systemic
    && lagHolds < NIGHTLY_MAX_SOURCE_LAG_HOLDS
    && isTransientSourceFailure({ failureCode: drama?.failureCode, failureMessage })
  if (heldForSourceLag) {
    item.sourceLagHolds = lagHolds + 1
    item.sourceLagAt = nowIso()
  }
  // Both a systemic block and an unconverged source leave the attempt budget
  // untouched; only a real generation attempt spends it.
  const spendsAttempt = !systemic && !heldForSourceLag

  // An existing performance is already past generation. Keep its
  // post-production/publishing recovery independent from the generation
  // circuit so an MP3 can finish while writer/planner probes are restricted.
  if (drama?.artifactId) {
    // The MP3 exists and only the feed is missing: publish, nothing else.
    if (needsPublishOnly(drama)) {
      await recoverPublication(env, item, drama, deps, generationController)
      return
    }
    // Post-production and finalize SPEND credits. While the account is out of
    // them, resuming would only buy the same refusal every hour.
    if (generationController.circuit?.failureClass === 'quota') {
      item.status = 'blocked'
      item.lastWorkflowStatus = 'blocked'
      item.episodeId = drama.id
      item.lastError = generationController.circuit.failureMessage || 'Waiting for Studio Credits to finish post-production.'
      item.updatedAt = nowIso()
      return
    }
    const recoveryAttempts = Number(item.recoveryAttempts || 0)
    if (!systemic && recoveryAttempts >= NIGHTLY_MAX_ATTEMPTS) {
      item.status = 'exhausted'
      item.lastError = 'Artifact publishing recovery exhausted.'
      return
    }
    item.workflowId = await resumeArtifactWorkflow(env, drama)
    item.episodeId = drama.id
    item.recoveryAttempts = systemic ? recoveryAttempts : recoveryAttempts + 1
    item.status = 'queued'
    item.lastWorkflowStatus = 'queued'
    item.updatedAt = nowIso()
    return
  }

  if (blocked) {
    await openGenerationCircuit(env, generationController, deps, {
      batch,
      item,
      drama,
      failureClass,
      message: failureMessage,
    })
  }

  if (!allowGeneration) {
    item.status = 'superseded'
    item.lastWorkflowStatus = 'superseded'
    item.lastError = failureMessage
      ? `Generation superseded by a newer nightly batch. Last failure: ${failureMessage}`
      : 'Generation superseded by a newer nightly batch.'
    item.updatedAt = nowIso()
    return
  }

  const attempt = Number(item.attempt || 1)
  if (spendsAttempt && attempt >= NIGHTLY_MAX_ATTEMPTS) {
    item.status = 'exhausted'
    item.lastError = 'Generation attempts exhausted.'
    return
  }

  const slot = await acquireGenerationSlot(env, generationController, deps, { batch, item })
  if (!slot.allowed) {
    item.status = 'blocked'
    item.lastWorkflowStatus = 'blocked'
    item.lastError = failureMessage || generationController.circuit?.failureMessage || 'Nightly generation circuit is open.'
    item.updatedAt = nowIso()
    return
  }

  const resumedWorkflowId = await resumeGenerationWorkflow(env, drama, deps, failureClass, { replan })
  if (resumedWorkflowId) {
    item.episodeId = drama.id
    item.workflowId = resumedWorkflowId
    await deps.patchDrama(env.DB, drama.id, {
      status: 'queued',
      error: null,
      failureClass: null,
      failureCode: null,
      failureMessage: null,
    })
  } else {
    const thread = await deps.fetchThread(item.url)
    // A replacement needs the same prepared source a first attempt gets: the
    // article hydrated onto the thread and the completeness metadata the
    // pipeline sends with the source. Passing the bare thread here left every
    // retry throwing before it could queue anything.
    const preparedSource = await prepareEpisodeSource(thread, deps)
    // The earlier attempt failed before any plan read its source. If the
    // thread has grown materially since, the pipeline may retire that capture
    // and take a fresh one; otherwise it reuses it (one source per thread).
    const failedBeforePlan = drama && !drama.planId && !drama.jobId
    const replacement = await createEpisodeWorkflow(env, preparedSource, {
      batchDate: batch.date,
      attempt: spendsAttempt ? attempt + 1 : attempt,
      sourceRecapture: failedBeforePlan
        ? { previousCommentCount: Number.isFinite(Number(drama.commentCount)) ? Number(drama.commentCount) : null }
        : null,
    }, deps)
    const oldEpisodeId = item.episodeId
    item.episodeId = replacement.drama.id
    item.workflowId = replacement.workflowId
    await deps.deleteOtherEpisodesOfThread(env.DB, thread.id, 'podcast', replacement.drama.id).catch(() => {})
    if (oldEpisodeId && oldEpisodeId !== replacement.drama.id) {
      // The created_at guard above normally removes it; this is only a no-op
      // cleanup for a row whose timestamp was malformed or absent.
      const old = await deps.getDrama(env.DB, oldEpisodeId)
      if (old?.status === 'failed') await deps.deleteDrama(env.DB, oldEpisodeId).catch(() => {})
    }
  }
  item.attempt = spendsAttempt ? attempt + 1 : attempt
  item.status = 'queued'
  item.lastWorkflowStatus = 'queued'
  item.lastError = null
  item.updatedAt = nowIso()
  if (slot.probe) {
    await recordGenerationProbe(env, generationController, deps, { batch, item })
  }
}

async function reconcileItem(
  env,
  batch,
  item,
  deps,
  generationController,
  { allowGeneration = true } = {},
) {
  if (['exhausted', 'superseded'].includes(item.status)) return
  const drama = item.episodeId ? await deps.getDrama(env.DB, item.episodeId) : null
  if (drama?.artifactId || isPublishedEpisode(drama)) {
    await closeGenerationCircuitForProbe(env, generationController, deps, item, drama)
  }
  if (isPublishedEpisode(drama)) {
    item.status = 'published'
    item.lastWorkflowStatus = 'complete'
    item.updatedAt = nowIso()
    return
  }

  // A finished episode held for the feed: no Workflow to inspect, just the
  // publish step's own schedule (this keeps held episodes cheap to walk).
  if (item.status === 'publish_blocked' && needsPublishOnly(drama)) {
    await recoverPublication(env, item, drama, deps, generationController)
    return
  }

  if (drama?.status === 'failed') {
    // Cumulative across the whole night — item.lastError alone undercounts
    // (a five-story batch shows at most five concurrent errors no matter how
    // many waves have failed), which kept the 'failing' alert from ever firing.
    batch.failureEvents = Number(batch.failureEvents || 0) + 1
    await recoverItem(
      env,
      batch,
      item,
      drama,
      deps,
      generationController,
      { allowGeneration },
    )
    return
  }

  let status = 'unknown'
  let instance = null
  if (item.workflowId) {
    try {
      const state = await workflowState(env, item.workflowId)
      status = state.status
      instance = state.instance
    } catch (error) {
      const message = error?.message || String(error)
      if (!/not found|does not exist|unknown instance/i.test(message)) {
        item.lastError = `Could not inspect Workflow ${item.workflowId}: ${message}`
        item.updatedAt = nowIso()
        return
      }
      status = 'unknown'
    }
  }
  item.lastWorkflowStatus = status
  item.updatedAt = nowIso()
  if (isActiveWorkflowStatus(status)) {
    item.status = status
    // The music watchdog guards post-production; once an MP3 exists the only
    // work left is the publish step, which has no music checkpoint to restart.
    if (!drama?.audioUrl) await recoverStalledMusicWake(env, batch, item, drama, instance, deps)
    return
  }

  // READY is not batch-complete until the feed publish progress event exists.
  // If a Workflow ended in that gap, resume the same artifact and its stable
  // publishing idempotency keys instead of buying another performance.
  // A ready episode resuming for publish is not a failure; a dead workflow
  // on an unfinished episode is.
  if (drama?.status !== 'ready') batch.failureEvents = Number(batch.failureEvents || 0) + 1
  await recoverItem(
    env,
    batch,
    item,
    drama,
    deps,
    generationController,
    { allowGeneration },
  )
}

async function topStories(deps) {
  const ids = await deps.fetchJson('https://hacker-news.firebaseio.com/v0/topstories.json')
  if (!Array.isArray(ids)) throw new Error('Hacker News topstories response was not an array.')
  return ids.slice(0, 100)
}

async function fillBatch(env, batch, deps, generationController, { allowGeneration = true } = {}) {
  if (!allowGeneration) return
  if (activeBatchItems(batch).length >= NIGHTLY_TARGET) return
  if (generationSelectionBlocked(generationController)) return
  if (readinessCircuitHolds(generationController)) return
  const attempted = new Set((batch.items ?? []).map((item) => String(item.hnId)))
  const seenThisPass = new Set()
  for (const id of await topStories(deps)) {
    if (generationSelectionBlocked(generationController)) break
    if (activeBatchItems(batch).length >= NIGHTLY_TARGET) break
    const hnId = String(id)
    if (attempted.has(hnId) || seenThisPass.has(hnId)) continue
    seenThisPass.add(hnId)

    try {
      const story = await deps.fetchJson(`https://hacker-news.firebaseio.com/v0/item/${hnId}.json`)
      if (story?.type !== 'story' || Number(story?.descendants || 0) < 10) continue
      const existing = await deps.findByHnIdAndMode(env.DB, hnId, 'podcast')
      if (isPublishedEpisode(existing)) continue

      let item
      if (existing && ['queued', 'running', 'ready', 'failed'].includes(existing.status)) {
        item = {
          hnId,
          url: existing.url || `https://news.ycombinator.com/item?id=${hnId}`,
          title: existing.title || story.title || `Hacker News #${hnId}`,
          episodeId: existing.id,
          workflowId: existing.id,
          attempt: Number(existing.nightlyAttempt || 1),
          recoveryAttempts: 0,
          status: existing.status,
          adopted: true,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        }
      } else {
        // Prove the source complete before reserving the single generation
        // slot. An unreadable/paywalled first candidate must not prevent this
        // pass from selecting the next story whose entire source is usable.
        const thread = await deps.fetchThread(`https://news.ycombinator.com/item?id=${hnId}`)
        const preparedSource = await prepareEpisodeSource(thread, deps)
        const generationSlot = await acquireGenerationSlot(
          env,
          generationController,
          deps,
          { batch, item: { hnId, episodeId: null } },
        )
        // A circuit can grant at most one probe. If it declined this eligible
        // candidate (cooldown or active prior probe), scanning the remaining
        // HN list cannot change that decision during this invocation.
        if (!generationSlot.allowed) {
          if (generationController.circuit) break
          continue
        }
        const created = await createEpisodeWorkflow(env, preparedSource, {
          batchDate: batch.date,
          attempt: 1,
          staggerSec: 0,
        }, deps)
        item = {
          hnId,
          url: thread.url,
          title: thread.title,
          episodeId: created.drama.id,
          workflowId: created.workflowId,
          attempt: 1,
          recoveryAttempts: 0,
          status: 'queued',
          createdAt: nowIso(),
          updatedAt: nowIso(),
        }
        if (generationSlot.probe) {
          await recordGenerationProbe(env, generationController, deps, { batch, item })
        }
      }
      batch.items.push(item)
      attempted.add(hnId)
      await persistBatch(env.DB, batch, deps)
      if (existing && ['ready', 'failed'].includes(existing.status)) {
        await reconcileItem(
          env,
          batch,
          item,
          deps,
          generationController,
          { allowGeneration },
        )
      }
      if (generationController.generationStarted) break
    } catch (error) {
      const sourceCode = error?.code ? ` (${error.code})` : ''
      recordBatchError(batch, `HN ${hnId}: ${error?.message || error}${sourceCode}`)
      await persistBatch(env.DB, batch, deps)
    }
  }
}

export async function reconcileNightlyBatch(env, date, {
  dependencies = {},
  generationController: suppliedGenerationController = null,
  allowGeneration = true,
  supersededByDate = null,
  itemOwnerDateByKey = null,
} = {}) {
  const deps = { ...defaultDependencies, ...dependencies }
  const generationController = suppliedGenerationController
    ?? await loadGenerationController(env, deps)
  let batch = await deps.getSetting(env.DB, nightlyBatchKey(date))
  if (!batch) {
    batch = {
      date,
      status: 'running',
      target: NIGHTLY_TARGET,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      items: [],
      errors: [],
    }
    await persistBatch(env.DB, batch, deps)
  }
  if (batch.status === 'complete') return batch
  if (!allowGeneration) {
    batch.generationSupersededAt ??= nowIso()
    batch.supersededByDate ??= supersededByDate
  }
  // Read readiness once per tick, before any item can start paid work.
  await ensureReadiness(env, generationController, deps, batch)

  for (const item of batch.items) {
    const ownerDates = itemOwnerDateByKey
      ? [
          item.episodeId ? itemOwnerDateByKey.get(`episode:${item.episodeId}`) : null,
          item.hnId ? itemOwnerDateByKey.get(`hn:${item.hnId}`) : null,
        ].filter(Boolean).sort()
      : []
    const ownerDate = ownerDates.at(-1)
    if (ownerDate && ownerDate !== date) {
      item.status = 'superseded'
      item.lastWorkflowStatus = 'superseded'
      item.lastError = `Superseded by newer nightly batch ${ownerDate} for the same episode.`
      item.updatedAt = nowIso()
      await persistBatch(env.DB, batch, deps)
      continue
    }
    try {
      await reconcileItem(
        env,
        batch,
        item,
        deps,
        generationController,
        { allowGeneration },
      )
    } catch (error) {
      item.lastError = error?.message || String(error)
      item.updatedAt = nowIso()
      recordBatchError(batch, `HN ${item.hnId}: ${item.lastError}`)
    }
    await persistBatch(env.DB, batch, deps)
  }

  try {
    await fillBatch(env, batch, deps, generationController, { allowGeneration })
  } catch (error) {
    recordBatchError(batch, error?.message || error)
  }

  const published = batch.items.filter((item) => item.status === 'published').length
  batch.published = published
  if (published >= NIGHTLY_TARGET) {
    batch.status = 'complete'
  } else if (!allowGeneration) {
    // A finished episode waiting on the feed keeps its batch alive, or it would
    // be forgotten when the batch is superseded and never published.
    const holding = publishHoldActive(batch, deps)
    batch.status = batch.items.some((item) => isActiveWorkflowStatus(item.status)
      || (holding && item.status === 'publish_blocked'))
      ? 'draining'
      : 'superseded'
  } else {
    batch.status = 'running'
  }
  if (batch.status === 'complete') {
    batch.completedAt = nowIso()
    await deps.setSetting(env.DB, 'dailyTopLastRun', date)
  }
  await persistBatch(env.DB, batch, deps)
  if (batch.status === 'running') {
    await maybeSendDistressAlert(env, batch, deps).catch(() => {})
  }
  return batch
}

export async function runNightlyReconciliation(env, {
  now = new Date(),
  dependencies = {},
} = {}) {
  const deps = { ...defaultDependencies, now: () => new Date(now), ...dependencies }
  const deployGate = activeWorkflowDeployGate(
    await deps.getSetting(env.DB, WORKFLOW_DEPLOY_GATE_KEY),
    now,
  )
  if (deployGate) return []
  const { date, hour } = centralRunContext(now)
  let pendingDates = await deps.getSetting(env.DB, 'dailyTopPendingDates')
  pendingDates = Array.isArray(pendingDates) ? pendingDates : []

  if (hour >= 19 && !pendingDates.includes(date)) {
    const existingBatch = await deps.getSetting(env.DB, nightlyBatchKey(date))
    const legacyComplete = (await deps.getSetting(env.DB, 'dailyTopLastRun')) === date && !existingBatch
    if (!legacyComplete && existingBatch?.status !== 'complete') pendingDates.push(date)
  }
  pendingDates = [...new Set(pendingDates)].sort()
  await deps.setSetting(env.DB, 'dailyTopPendingDates', pendingDates)

  // A thread can be adopted by adjacent dates while a long Workflow is still
  // running. Assign the shared episode/thread to the newest pending batch
  // before reconciling the oldest one, otherwise both dates can independently
  // resume the same artifact for post-production.
  const pendingBatches = new Map()
  const itemOwnerDateByKey = new Map()
  for (const batchDate of pendingDates) {
    const batch = await deps.getSetting(env.DB, nightlyBatchKey(batchDate))
    pendingBatches.set(batchDate, batch)
    for (const item of batch?.items ?? []) {
      if (['exhausted', 'superseded'].includes(item.status)) continue
      if (item.episodeId) itemOwnerDateByKey.set(`episode:${item.episodeId}`, batchDate)
      if (item.hnId) itemOwnerDateByKey.set(`hn:${item.hnId}`, batchDate)
    }
  }

  let generationBatchDate = null
  for (const candidateDate of [...pendingDates].reverse()) {
    const candidateBatch = pendingBatches.get(candidateDate)
    if (!candidateBatch?.generationSupersededAt) {
      generationBatchDate = candidateDate
      break
    }
  }

  const generationController = await loadGenerationController(env, deps)
  const stillPending = []
  const batches = []
  for (const batchDate of pendingDates) {
    try {
      const batch = await reconcileNightlyBatch(env, batchDate, {
        dependencies: deps,
        generationController,
        allowGeneration: batchDate === generationBatchDate,
        supersededByDate: generationBatchDate,
        itemOwnerDateByKey,
      })
      batches.push(batch)
      if (!['complete', 'superseded'].includes(batch.status)) stillPending.push(batchDate)
    } catch {
      // Keep the date pending so the next hourly cron retries reconciliation.
      stillPending.push(batchDate)
    }
  }
  await deps.setSetting(env.DB, 'dailyTopPendingDates', stillPending)
  return batches
}
