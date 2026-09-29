/**
 * Stable failure classes shared by the Workflow and nightly reconciler.
 * Prefer Sleeper Hit's machine-readable failure code, while retaining message
 * matching so rows created by older deployments recover correctly.
 */

export const PROVIDER_BLOCK_RE =
  /high[- ]frequency non[- ]compliant requests|detected high[- ]frequency|temporarily blocked/i

// "Not enough Studio Credits…" is the platform's OWN balance refusal (the 402
// on a story job, a finalize, a render). It is the one quota message HNR sees
// most, and it went unclassified through three outages (07-29, 09-02..11,
// 09-22..27): every one of them read as an ordinary failure, spent attempts,
// and never opened the circuit or emailed anyone.
export const QUOTA_CLASS_RE =
  /usage limits|quota (?:exceeded|reached)|insufficient_credits|insufficient credits|not enough studio credits|\btop[- ]?up\b|credit balance|requires more credits|can only afford|add more credits|exceeded your current|payment required|billing|incorrect api key|rate limit/i

export const CONTRACT_CLASS_RE =
  /is invalid:|Too big:|Invalid key in record|Supply every speaking character|Table-read outline page budgets total|scriptBlueprint\.pageTarget|Schema validation failed|response did not match schema/i

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
export const CAST_NOT_READY_RE =
  /cast_precondition_failed|no finalized (?:episode screenplay|cast)|finalized episode screenplay with a complete cast|uncast speaker/i

/**
 * Classes that describe the PROJECT or the ACCOUNT rather than one episode. The
 * nightly's hourly probe for these is a cheap readiness read (the project's
 * workspace gate, its table-read readiness, the credit balance), never another
 * paid episode: building an episode cannot tell us more than the read does.
 */
export const READINESS_CLASSES = Object.freeze(['project_not_ready', 'cast_not_ready', 'quota'])

/** Every class that opens the generation circuit. */
export const SYSTEMIC_CLASSES = Object.freeze(['provider', 'project_not_ready', 'cast_not_ready', 'quota', 'contract'])

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
  if (typeof value === 'string') return { code: '', message: value }
  if (!value || typeof value !== 'object') return { code: '', message: String(value || '') }
  return {
    code: String(value.failureCode || value.code || ''),
    message: String(value.failureMessage || value.message || value.error || ''),
  }
}

export function classifySystemicFailure(value) {
  const { code, message } = failureSignals(value)
  if (code === 'provider_capacity_blocked' || PROVIDER_BLOCK_RE.test(message)) return 'provider'
  if (code === PROJECT_NOT_READY_CODE || PROJECT_NOT_READY_RE.test(message)) return 'project_not_ready'
  if (code === CAST_NOT_READY_CODE || CAST_NOT_READY_RE.test(message)) return 'cast_not_ready'
  if (code === 'insufficient_credits' || QUOTA_CLASS_RE.test(message)) return 'quota'
  if (CONTRACT_CLASS_RE.test(message)) return 'contract'
  return null
}

export function isProviderBlockedFailure(value) {
  return classifySystemicFailure(value) === 'provider'
}

export function isQuotaClassFailure(value) {
  return classifySystemicFailure(value) === 'quota'
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
