import test from 'node:test'
import assert from 'node:assert/strict'

import { appendProgress } from '../worker/store.mjs'

function dramaDb(initial) {
  let drama = structuredClone(initial)
  return {
    get drama() { return drama },
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() {
              if (!sql.startsWith('SELECT data')) throw new Error(`Unexpected read: ${sql}`)
              return drama ? { data: JSON.stringify(drama) } : null
            },
            async run() {
              if (!sql.startsWith('INSERT INTO episodes')) throw new Error(`Unexpected write: ${sql}`)
              drama = JSON.parse(values[6])
              return { meta: { changes: 1 } }
            },
          }
        },
      }
    },
  }
}

test('progress telemetry suppresses exact Workflow replay duplicates', async () => {
  const db = dramaDb({
    id: 'episode_1',
    hnId: '123',
    mode: 'podcast',
    status: 'running',
    title: 'Test',
    createdAt: '2026-07-15T00:00:00.000Z',
    progress: [{ at: '2026-07-15T00:00:00.000Z', message: 'Adding this episode to HNRadio…' }],
  })

  await appendProgress(db, 'episode_1', 'Mixing the durable MP3 (voices + music + SFX)…')
  await appendProgress(db, 'episode_1', 'Adding this episode to HNRadio…')
  await appendProgress(db, 'episode_1', 'Mixing the durable MP3 (voices + music + SFX)…')

  assert.deepEqual(db.drama.progress.map((entry) => entry.message), [
    'Adding this episode to HNRadio…',
    'Mixing the durable MP3 (voices + music + SFX)…',
  ])
})

test('progress telemetry allows the same event in a later recovery run', async () => {
  const db = dramaDb({
    id: 'episode_1',
    hnId: '123',
    mode: 'podcast',
    status: 'ready',
    title: 'Test',
    createdAt: '2026-07-15T00:00:00.000Z',
    progress: [],
  })

  await appendProgress(db, 'episode_1', 'Repairing post-production…', {
    runId: 'repair_1', eventKey: 'repair-start',
  })
  await appendProgress(db, 'episode_1', 'Repairing post-production…', {
    runId: 'repair_1', eventKey: 'repair-start',
  })
  await appendProgress(db, 'episode_1', 'Repairing post-production…', {
    runId: 'repair_2', eventKey: 'repair-start',
  })

  assert.deepEqual(db.drama.progress.map((entry) => entry.runId), ['repair_1', 'repair_2'])
})
