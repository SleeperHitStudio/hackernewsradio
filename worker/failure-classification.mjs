/**
 * Stable failure classes shared by the Workflow and nightly reconciler.
 * Prefer Sleeper Hit's machine-readable failure code, while retaining message
 * matching so rows created by older deployments recover correctly.
 */

export const PROVIDER_BLOCK_RE =
  /high[- ]frequency non[- ]compliant requests|detected high[- ]frequency|temporarily blocked/i

// STUDIO CREDITS: the platform's OWN balance. Its refusal is typed (402
// `insufficient_credits`) and its prose always names Studio Credits ("Not
// enough Studio Credits to start this job (need 20, have 4). Top up or wait
// for next month's bucket."). It went unclassified through three outages
// (07-29, 09-02..11, 09-22..27). The preflight's GET /credits measures exactly
// this, so it is a READINESS class: the free read probes it.
export const PLATFORM_CREDITS_RE = /insufficient_credits|studio credits/i

// A PROVIDER's quota, billing or rate cliff behind the platform (OpenRouter
// "can only afford", "exceeded your current quota", a usage limit, a rate
// limit). The Studio Credit balance cannot see any of these, so a free read
// cannot probe them: the circuit's probe is one episode, as it always was.
export const PROVIDER_QUOTA_RE =
  /usage limits|quota (?:exceeded|reached)|exceeded your current|insufficient credits|credit balance|requires more credits|can only afford|add more credits|payment required|billing|incorrect api key|rate limit/i

export const CONTRACT_CLASS_RE =
  /is invalid:|Too big:|Invalid key in record|Supply every speaking character|Table-read outline page budgets total|scriptBlueprint\.pageTarget/i

/**
 * A MODEL'S ANSWER missed its schema: the platform's planner produced a plan and one field came back the
 * wrong shape ("Planning failed after the first completed generation. Schema validation failed —
 * artifacts: Invalid input: expected array, received string", 2026-10-03, the first in 14 days of
 * plans). That is the model, once, not the platform refusing what HNR sent, so it is an ordinary item
 * failure the next attempt retries. It never opens the generation circuit or pages the operator.
 * Checked BEFORE the contract class, so an output that also says "Too big:" (a field the model made too
 * long) stays an item failure; a REQUEST HNR sent that the platform refuses ("`notes` is invalid: Too
 * big: …") has no such prefix and is still contract.
 */
export const MODEL_OUTPUT_MISS_RE =
  /Planning failed after the first completed generation|response did not match schema/i

/**
 * THE PROJECT IS NOT READY. The platform refuses a plan or a job with a typed
 * 409 `project_precondition_failed` until the HNRadio project has finished the
 * development stage it names (`details.stage`). That is STATE, not a fault:
 * the identical call refuses the same way every hour until someone finishes the
 * stage, so it must stop the show and tell the operator — never retry.
 */
export const PROJECT_NOT_READY_CODE = 'project_precondition_failed'
export const PROJECT_NOT_READY_RE =
  /project_precondition_failed|full Series Bible coverage|before starting episodes|project has not (?:reached|passed|finished)/i

/**
 * THE CAST IS NOT READY. A table read the platform cannot voice — no cast canon
 * voice for a speaker, no finalized cast — is a typed 409
 * `cast_precondition_failed`. Also state: the fix is a voice in the cast canon,
 * not another attempt. (The "Supply every speaking character" voiceMap refusal
 * is deliberately NOT this class: that one is recovered in-run by recasting
 * without the pinned map, see shouldRecastWithoutPinnedCast.)
 */
export const CAST_NOT_READY_CODE = 'cast_precondition_failed'
/**
 * HNR pushes its pinned host voices into the cast canon before the preflight
 * judges the cast; a push the Story API REFUSED leaves the cast unvoiceable,
 * so it is the same class, under HNR's own code so the refusal is named.
 */
export const CAST_CANON_SYNC_REFUSED_CODE = 'cast_canon_sync_refused'
export const CAST_NOT_READY_RE =
  /cast_precondition_failed|no finalized (?:episode screenplay|cast)|finalized episode screenplay with a complete cast|Finalize the episode screenplay and complete its Cast|uncast speaker/i

/**
 * NO STANDING APPROVAL. HNR is unattended: it approves plans and publishes only
 * under the PublishingSeries' standing approval bound to its own API key, never
 * by claiming a human `userConfirmed`. Without that grant it must not spend at
 * all, so the pipeline stops before any upload, plan or job with one of these
 * codes, and the platform's own refusal of an uncovered approval reads the same.
 */
export const APPROVAL_MISSING_CODES = Object.freeze([
  'publishing_series_missing',
  'standing_approval_unavailable',
  'standing_approval_missing',
  'standing_approval_unverifiable',
  'standing_approval_other_key',
  'standing_approval_inactive',
  'standing_approval_unreadable',
])
export const APPROVAL_MISSING_RE = /`?userConfirmed: true`? is required|standing approval/i

/**
 * THE KEY OR THE PROJECT IS REFUSED. The Story API answers 401/403/404 for a
 * revoked or rotated key, a missing scope, or a deleted project. Every call
 * refuses the same way until someone fixes the credential or the project id.
 */
export const ACCESS_CODES = Object.freeze([
  'authentication_required',
  'invalid_api_key',
  'api_key_revoked',
  'api_key_expired',
  'insufficient_scope',
  'project_not_found',
])

/**
 * Classes that describe the PROJECT or the ACCOUNT rather than one episode. The
 * nightly's hourly probe for these is a cheap readiness read (the project's
 * workspace gate, its table-read readiness, the credit balance), never another
 * paid episode: building an episode cannot tell us more than the read does.
 */
export const READINESS_CLASSES = Object.freeze(['access', 'project_not_ready', 'cast_not_ready', 'approval_missing', 'quota'])

/** Every class that opens the generation circuit. */
export const SYSTEMIC_CLASSES = Object.freeze(['provider', 'provider_quota', 'contract', ...READINESS_CLASSES])

export function isReadinessClass(failureClass) {
  return READINESS_CLASSES.includes(failureClass)
}

export function isSystemicClass(failureClass) {
  return SYSTEMIC_CLASSES.includes(failureClass)
}

/**
 * Failures confined to the job's PLANNED SOUNDTRACK. HNR never ships planned
 * music: post-production overwrites the bookends with the banked jazz theme and
 * mutes every middle bed, so a read that became performable is the complete
 * deliverable even when Lyria never rendered a note.
 */
export const MUSIC_CLASS_RE =
  /planned music did not complete|planned lyria music clip|lyria clip generation|music clip (?:failed|generation)|soundtrack (?:render|generation) failed/i

/**
 * A source capture that was refused because Hacker News and its search index
 * had not converged yet. Deliberately NOT a systemic class: it is one story
 * being briefly unreadable, not the show being broken, so it must never open
 * the generation circuit. It only earns the item a few retries that do not
 * count against its attempt budget, because the thread is expected to settle
 * within minutes and the next hourly tick will find it whole.
 */
export const SOURCE_LAG_CLASS_RE =
  /is not synchronized yet|completeness proof does not match|Could not capture a complete Hacker News thread/i

export function isTransientSourceFailure(value) {
  const { code, message } = failureSignals(value)
  if (classifySystemicFailure(value)) return false
  return code === 'hn_thread_incomplete' || SOURCE_LAG_CLASS_RE.test(message)
}

function failureSignals(value) {
  if (typeof value === 'string') return { code: '', message: value, status: null }
  if (!value || typeof value !== 'object') return { code: '', message: String(value || ''), status: null }
  const status = Number(value.failureStatus ?? value.status)
  return {
    code: String(value.failureCode || value.code || ''),
    message: String(value.failureMessage || value.message || value.error || ''),
    status: Number.isInteger(status) ? status : null,
  }
}

export function classifySystemicFailure(value) {
  const { code, message, status } = failureSignals(value)
  if (code === 'provider_capacity_blocked' || PROVIDER_BLOCK_RE.test(message)) return 'provider'
  if (ACCESS_CODES.includes(code) || status === 401) return 'access'
  if (code === PROJECT_NOT_READY_CODE || PROJECT_NOT_READY_RE.test(message)) return 'project_not_ready'
  if (code === CAST_NOT_READY_CODE || code === CAST_CANON_SYNC_REFUSED_CODE || CAST_NOT_READY_RE.test(message)) return 'cast_not_ready'
  if (APPROVAL_MISSING_CODES.includes(code) || APPROVAL_MISSING_RE.test(message)) return 'approval_missing'
  if (code === 'insufficient_credits' || status === 402 || PLATFORM_CREDITS_RE.test(message)) return 'quota'
  if (PROVIDER_QUOTA_RE.test(message)) return 'provider_quota'
  if (MODEL_OUTPUT_MISS_RE.test(message)) return null
  if (CONTRACT_CLASS_RE.test(message)) return 'contract'
  return null
}

/** A model's answer missed its schema (MODEL_OUTPUT_MISS_RE): retried as an item, never systemic. */
export function isModelOutputMissFailure(value) {
  return MODEL_OUTPUT_MISS_RE.test(failureSignals(value).message)
}

export function isProviderBlockedFailure(value) {
  return classifySystemicFailure(value) === 'provider'
}

/** Out of Studio Credits (the platform's own balance). */
export function isQuotaClassFailure(value) {
  return classifySystemicFailure(value) === 'quota'
}

/** A provider's quota/billing/rate cliff behind the platform. */
export function isProviderQuotaFailure(value) {
  return classifySystemicFailure(value) === 'provider_quota'
}

export function isApprovalMissingFailure(value) {
  return classifySystemicFailure(value) === 'approval_missing'
}

export function isAccessFailure(value) {
  return classifySystemicFailure(value) === 'access'
}

export function isContractClassFailure(value) {
  return classifySystemicFailure(value) === 'contract'
}

export function isProjectNotReadyFailure(value) {
  return classifySystemicFailure(value) === 'project_not_ready'
}

export function isCastNotReadyFailure(value) {
  return classifySystemicFailure(value) === 'cast_not_ready'
}

/**
 * True when the ONLY thing that broke was the planned soundtrack. Deliberately
 * message-scoped: a quota/provider outage that also killed the writer must stay
 * a hard failure, because there is no performable read to salvage.
 */
export function isMusicClassFailure(value) {
  const { code, message } = failureSignals(value)
  return code === 'music_generation_failed' || MUSIC_CLASS_RE.test(message)
}
