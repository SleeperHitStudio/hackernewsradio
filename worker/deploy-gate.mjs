import { getSetting } from './store.mjs'

export const WORKFLOW_DEPLOY_GATE_KEY = 'workflowDeployGate'

export function activeWorkflowDeployGate(gate, now = new Date()) {
  if (!gate || gate.state !== 'locked') return null
  const expiresAtMs = Date.parse(gate.expiresAt)
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now.getTime()) return null
  return gate
}

export function workflowDeployRetryAfterSeconds(gate, now = new Date()) {
  const expiresAtMs = Date.parse(gate?.expiresAt)
  if (!Number.isFinite(expiresAtMs)) return 60
  return Math.min(60, Math.max(1, Math.ceil((expiresAtMs - now.getTime()) / 1000)))
}

export async function getActiveWorkflowDeployGate(db, {
  readSetting = getSetting,
  now = new Date(),
} = {}) {
  const gate = await readSetting(db, WORKFLOW_DEPLOY_GATE_KEY)
  return activeWorkflowDeployGate(gate, now)
}
