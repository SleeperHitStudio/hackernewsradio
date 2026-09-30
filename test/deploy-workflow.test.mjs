import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const deployWorkflowUrl = new URL('../.github/workflows/deploy.yml', import.meta.url)

test('deploy drain checks every Cloudflare Workflow non-terminal state', async () => {
  const workflow = await readFile(deployWorkflowUrl, 'utf8')
  const statusLine = workflow.match(/active_statuses=\(([^)]+)\)/)?.[1]

  assert.ok(statusLine, 'deploy workflow must declare active_statuses')
  assert.deepEqual(statusLine.trim().split(/\s+/), [
    'queued',
    'running',
    'paused',
    'waiting',
    'waitingForPause',
  ])
})

test('a deploy never lifts an owner hold on the workflow gate', async () => {
  // The gate step used to overwrite any workflowDeployGate row with the run's own lock, and the
  // release step then deleted it: every deploy silently lifted a pause the owner had set in D1.
  const workflow = await readFile(deployWorkflowUrl, 'utf8')
  const gateStep = workflow.slice(workflow.indexOf('- name: Gate new Workflow starts'), workflow.indexOf('- name: Wait for every active Workflow instance'))
  assert.match(gateStep, /ON CONFLICT \(key\) DO UPDATE SET[\s\S]*WHERE json_extract\(settings\.value, '\$\.runId'\) IS NOT NULL/)
  assert.match(gateStep, /OR json_extract\(settings\.value, '\$\.state'\) IS NOT 'locked'/)
  assert.match(gateStep, /OR json_extract\(settings\.value, '\$\.expiresAt'\) <= strftime/)
  const releaseStep = workflow.slice(workflow.indexOf('- name: Release Workflow deploy gate'))
  assert.match(releaseStep, /DELETE FROM settings[\s\S]*WHERE key = 'workflowDeployGate'[\s\S]*json_extract\(value, '\$\.runId'\) AS TEXT\) = '\$\{GITHUB_RUN_ID\}'/)
})
