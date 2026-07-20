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
