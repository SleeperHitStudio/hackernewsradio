import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

import {
  DROPPED_STATUS,
  appendProgress,
  deleteOtherEpisodesOfThread,
  getDrama,
  listDramas,
  patchDrama,
  upsertDrama,
} from '../worker/store.mjs'

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

// ── A dropped episode is frozen (owner, 2026-10-04) — against real SQLite and the real schema ─────────

/** D1's prepare/bind/first/all/run over node:sqlite, with the migrations applied. */
function sqliteD1() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'))
  return {
    sqlite,
    prepare(sql) {
      const statement = sqlite.prepare(sql)
      const bound = (values) => ({
        async first() { return statement.get(...values) ?? null },
        async all() { return { results: statement.all(...values) } },
        async run() { return { meta: { changes: Number(statement.run(...values).changes) } } },
      })
      return { ...bound([]), bind: (...values) => bound(values) }
    },
  }
}

const episode = (id, extra = {}) => ({
  id, hnId: '49949438', mode: 'podcast', status: 'running', title: 'Bob Cringely Has Died',
  createdAt: '2026-10-04T04:01:23.885Z', progress: [], ...extra,
})

test('a dropped episode row is frozen: no writer can flip it to running, ready or failed', async () => {
  const db = sqliteD1()
  await upsertDrama(db, episode('ep4', { artifactId: 'artifact_4' }))
  // The drop itself is an ordinary write to a row that is not yet dropped.
  await upsertDrama(db, { ...(await getDrama(db, 'ep4')), status: DROPPED_STATUS, dropped: { by: 'owner', reason: 'death thread' } })
  assert.equal((await getDrama(db, 'ep4')).status, 'dropped')

  // Everything a Workflow, recovery or retry writes is refused by the row itself.
  await patchDrama(db, 'ep4', { status: 'running', error: null })
  await patchDrama(db, 'ep4', { status: 'ready', audioUrl: 'https://files.example/ep4.mp3' })
  await upsertDrama(db, episode('ep4', { status: 'failed' }))
  await appendProgress(db, 'ep4', 'Published to the HNR podcast feed.')

  const row = db.sqlite.prepare('SELECT status, data FROM episodes WHERE id = ?').get('ep4')
  assert.equal(row.status, 'dropped')
  const data = JSON.parse(row.data)
  assert.equal(data.status, 'dropped')
  assert.equal(data.audioUrl, undefined)
  assert.deepEqual(data.progress, [])
  assert.deepEqual(data.dropped, { by: 'owner', reason: 'death thread' })
})

test('the site never lists a dropped episode; the operator\'s includeFailed view does', async () => {
  const db = sqliteD1()
  await upsertDrama(db, episode('ep4', { status: DROPPED_STATUS }))
  await upsertDrama(db, episode('ep5', { hnId: '49950554', status: 'ready', title: 'Use the platform', createdAt: '2026-10-04T05:01:00.000Z' }))
  await upsertDrama(db, episode('ep6', { hnId: '1', status: 'failed', title: 'Failed', createdAt: '2026-10-04T06:01:00.000Z' }))

  assert.deepEqual((await listDramas(db)).map((drama) => drama.id), ['ep5'])
  assert.deepEqual((await listDramas(db, { includeFailed: true })).map((drama) => drama.id), ['ep6', 'ep5', 'ep4'])
})

test('a newer take of the thread never deletes the dropped row: it is the thread\'s tombstone', async () => {
  const db = sqliteD1()
  await upsertDrama(db, episode('ep4', { status: DROPPED_STATUS, createdAt: '2026-10-04T04:00:00.000Z' }))
  await upsertDrama(db, episode('older_failed', { status: 'failed', createdAt: '2026-10-03T04:00:00.000Z' }))
  await upsertDrama(db, episode('newer', { status: 'ready', createdAt: '2026-10-05T04:00:00.000Z' }))

  assert.equal(await deleteOtherEpisodesOfThread(db, '49949438', 'podcast', 'newer'), 1)
  assert.equal((await getDrama(db, 'older_failed')), null)
  assert.equal((await getDrama(db, 'ep4')).status, 'dropped')
})
