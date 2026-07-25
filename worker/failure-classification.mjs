/**
 * Stable failure classes shared by the Workflow and nightly reconciler.
 * Prefer Sleeper Hit's machine-readable failure code, while retaining message
 * matching so rows created by older deployments recover correctly.
 */

export const PROVIDER_BLOCK_RE =
  /high[- ]frequency non[- ]compliant requests|detected high[- ]frequency|temporarily blocked/i

export const QUOTA_CLASS_RE =
  /usage limits|quota (?:exceeded|reached)|insufficient_credits|insufficient credits|credit balance|requires more credits|can only afford|add more credits|exceeded your current|payment required|billing|incorrect api key|rate limit/i

export const CONTRACT_CLASS_RE =
  /is invalid:|Too big:|Invalid key in record|Supply every speaking character|Table-read outline page budgets total|scriptBlueprint\.pageTarget|Schema validation failed|response did not match schema/i

/**
 * Failures confined to the job's PLANNED SOUNDTRACK. HNR never ships planned
 * music: post-production overwrites the bookends with the banked jazz theme and
 * mutes every middle bed, so a read that became performable is the complete
 * deliverable even when Lyria never rendered a note.
 */
export const MUSIC_CLASS_RE =
  /planned music did not complete|planned lyria music clip|lyria clip generation|music clip (?:failed|generation)|soundtrack (?:render|generation) failed/i

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
  if (QUOTA_CLASS_RE.test(message)) return 'quota'
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

/**
 * True when the ONLY thing that broke was the planned soundtrack. Deliberately
 * message-scoped: a quota/provider outage that also killed the writer must stay
 * a hard failure, because there is no performable read to salvage.
 */
export function isMusicClassFailure(value) {
  const { code, message } = failureSignals(value)
  return code === 'music_generation_failed' || MUSIC_CLASS_RE.test(message)
}
