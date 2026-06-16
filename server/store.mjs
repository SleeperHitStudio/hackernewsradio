/**
 * Episode store, backed by Postgres (in-cluster). Replaces the old JSON file.
 *
 * Table `episodes` keeps a few indexed columns for querying/dedup plus the full
 * episode object as JSONB in `data`. On first boot, if the table is empty and a
 * legacy data/dramas.json exists (the old store, on the PVC), it migrates it —
 * keeping only the newest READY episode per (hn_id, mode) and dropping failed /
 * duplicate rows (the "delete duplicate test episodes" cleanup).
 */
import pg from 'pg'
import { readFile } from 'node:fs/promises'
import { config } from './config.mjs'

let pool = null
let ready = null

function getPool() {
  if (!pool) pool = new pg.Pool({ connectionString: config.databaseUrl, max: 5 })
  return pool
}

async function init() {
  const db = getPool()
  await db.query(`
    CREATE TABLE IF NOT EXISTS episodes (
      id          text PRIMARY KEY,
      hn_id       text NOT NULL,
      mode        text NOT NULL DEFAULT 'podcast',
      status      text NOT NULL,
      title       text,
      created_at  timestamptz NOT NULL DEFAULT now(),
      data        jsonb NOT NULL
    );
    CREATE INDEX IF NOT EXISTS episodes_hn_mode_idx ON episodes (hn_id, mode);
    CREATE INDEX IF NOT EXISTS episodes_created_idx ON episodes (created_at DESC);
  `)
  await migrateLegacyJsonIfEmpty(db)
}

function ensureReady() {
  if (!ready) ready = init()
  return ready
}

async function migrateLegacyJsonIfEmpty(db) {
  const { rows } = await db.query('SELECT count(*)::int AS n FROM episodes')
  if (rows[0].n > 0) return
  let legacy
  try {
    legacy = JSON.parse(await readFile(config.dramasFile, 'utf8'))
  } catch {
    return // no legacy file
  }
  if (!Array.isArray(legacy) || legacy.length === 0) return

  // Keep the newest READY episode per (hn_id, mode); drop failed + older dups.
  const best = new Map()
  for (const d of legacy) {
    if (d.status !== 'ready') continue
    const key = `${d.hnId}|${d.mode || 'podcast'}`
    const prev = best.get(key)
    if (!prev || (d.createdAt || '') > (prev.createdAt || '')) best.set(key, d)
  }
  let migrated = 0
  for (const d of best.values()) {
    // Write directly with `db` — calling the public upsertDrama here would
    // re-enter ensureReady() and await the in-flight init promise → deadlock.
    await writeEpisode(db, d)
    migrated++
  }
  console.log(`[store] migrated ${migrated} ready episode(s) from legacy JSON (deduped from ${legacy.length})`)
}

async function writeEpisode(db, drama) {
  await db.query(
    `INSERT INTO episodes (id, hn_id, mode, status, title, created_at, data)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO UPDATE SET
       hn_id = EXCLUDED.hn_id, mode = EXCLUDED.mode, status = EXCLUDED.status,
       title = EXCLUDED.title, data = EXCLUDED.data`,
    [drama.id, drama.hnId, drama.mode || 'podcast', drama.status, drama.title,
     drama.createdAt || new Date().toISOString(), JSON.stringify(drama)],
  )
}

function rowToData(row) {
  return row.data
}

export async function listDramas({ q = '', includeFailed = false } = {}) {
  await ensureReady()
  const params = []
  const where = []
  if (!includeFailed) where.push(`status <> 'failed'`)
  if (q.trim()) { params.push(`%${q.trim()}%`); where.push(`title ILIKE $${params.length}`) }
  const sql = `SELECT data FROM episodes ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`
  const { rows } = await getPool().query(sql, params)
  return rows.map(rowToData)
}

export async function getDrama(id) {
  await ensureReady()
  const { rows } = await getPool().query('SELECT data FROM episodes WHERE id = $1', [id])
  return rows[0] ? rows[0].data : null
}

/** Find an existing episode for an HN item id + mode (newest first). */
export async function findByHnIdAndMode(hnId, mode) {
  await ensureReady()
  const { rows } = await getPool().query(
    'SELECT data FROM episodes WHERE hn_id = $1 AND mode = $2 ORDER BY created_at DESC LIMIT 1',
    [hnId, mode],
  )
  return rows[0] ? rows[0].data : null
}

export async function upsertDrama(drama) {
  await ensureReady()
  await writeEpisode(getPool(), drama)
  return drama
}

export async function patchDrama(id, patch) {
  await ensureReady()
  const current = await getDrama(id)
  if (!current) return null
  const next = { ...current, ...patch }
  await upsertDrama(next)
  return next
}

/** Delete episodes (used for admin cleanup). */
export async function deleteDramas(ids) {
  await ensureReady()
  if (!ids?.length) return 0
  const { rowCount } = await getPool().query('DELETE FROM episodes WHERE id = ANY($1)', [ids])
  return rowCount
}
