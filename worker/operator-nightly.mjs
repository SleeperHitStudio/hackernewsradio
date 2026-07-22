import { operatorAuthorization } from './operator-auth.mjs'
import { runNightlyReconciliation } from './nightly.mjs'
import {
  getActiveWorkflowDeployGate,
  workflowDeployRetryAfterSeconds,
} from './deploy-gate.mjs'

/**
 * Run the same idempotent reconciliation used by the hourly cron, behind the
 * existing operator credential and deploy gate. Returning response metadata
 * keeps this control path independently testable from the Worker entrypoint.
 */
export async function operatorNightlyReconcile(request, env, {
  now = () => new Date(),
  authorize = operatorAuthorization,
  getDeployGate = getActiveWorkflowDeployGate,
  runReconciliation = runNightlyReconciliation,
} = {}) {
  const authorization = await authorize(request, env.HNR_OPERATOR_TOKEN)
  if (authorization === 'disabled') return { status: 404, body: { error: 'Not found' } }
  if (authorization !== 'authorized') return { status: 401, body: { error: 'Unauthorized' } }

  const reconciledAt = now()
  const deployGate = await getDeployGate(env.DB, { now: reconciledAt })
  if (deployGate) {
    const retryAfter = workflowDeployRetryAfterSeconds(deployGate, reconciledAt)
    return {
      status: 503,
      headers: { 'Retry-After': String(retryAfter) },
      body: {
        error: 'Workflow starts are briefly paused while the Worker deploy stabilizes.',
        code: 'workflow_deploying',
        retryAfterSeconds: retryAfter,
      },
    }
  }

  const batches = await runReconciliation(env, { now: reconciledAt })
  return {
    status: 200,
    body: {
      reconciledAt: reconciledAt.toISOString(),
      batches: batches.map((batch) => ({
        date: batch.date,
        status: batch.status,
        published: Number(batch.published || 0),
        active: (batch.items || []).filter(
          (item) => !['exhausted', 'superseded'].includes(item.status),
        ).length,
      })),
    },
  }
}
