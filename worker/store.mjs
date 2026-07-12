/**
 * Episode + settings store, backed by Cloudflare D1. Same surface as the
 * Postgres server/store.mjs so the pipeline port stays line-comparable.
 * `data` holds the full episode object as JSON text.
 */

function rowToData(row) {
  return JSON.parse(row.data)
}

export async function listDramas(db, { q = '', includeFailed = false } = {}) {
  const where = []
  const binds = []
  if (!includeFailed) where.push(`status <> 'failed'`)
  if (q.trim()) { binds.push(`%${q.trim()}%`); where.push(`title LIKE ?${binds.length}`) }
  const sql = `SELECT data FROM episodes ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC`
  const { results } = await db.prepare(sql).bind(...binds).all()
  return results.map(rowToData)
}

export async function getDrama(db, id) {
  const row = await db.prepare('SELECT data FROM episodes WHERE id = ?1').bind(id).first()
  return row ? rowToData(row) : null
}

export async function findByHnIdAndMode(db, hnId, mode) {
  const row = await db
    .prepare('SELECT data FROM episodes WHERE hn_id = ?1 AND mode = ?2 ORDER BY created_at DESC LIMIT 1')
    .bind(String(hnId), mode)
    .first()
  return row ? rowToData(row) : null
}

export async function upsertDrama(db, drama) {
  await db
    .prepare(
      `INSERT INTO episodes (id, hn_id, mode, status, title, created_at, data)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT (id) DO UPDATE SET
         hn_id = excluded.hn_id, mode = excluded.mode, status = excluded.status,
         title = excluded.title, data = excluded.data`,
    )
    .bind(drama.id, String(drama.hnId), drama.mode || 'podcast', drama.status, drama.title ?? null,
      drama.createdAt || new Date().toISOString(), JSON.stringify(drama))
    .run()
  return drama
}

export async function patchDrama(db, id, patch) {
  const current = await getDrama(db, id)
  if (!current) return null
  const next = { ...current, ...patch }
  await upsertDrama(db, next)
  return next
}

export async function appendProgress(db, id, message) {
  const d = await getDrama(db, id)
  const progress = [...(d?.progress ?? []), { at: new Date().toISOString(), message }]
  if (d) await upsertDrama(db, { ...d, progress })
  return progress
}

export async function deleteOtherEpisodesOfThread(db, hnId, mode, keepId) {
  const res = await db
    .prepare('DELETE FROM episodes WHERE hn_id = ?1 AND mode = ?2 AND id <> ?3')
    .bind(String(hnId), mode, keepId)
    .run()
  return res.meta?.changes ?? 0
}

export async function failStaleRunning(db) {
  // With Workflows the pipeline survives restarts, so this only catches
  // instances that terminated abnormally; the workflow itself marks failures.
  return 0
}

export async function getSetting(db, key) {
  const row = await db.prepare('SELECT value FROM settings WHERE key = ?1').bind(key).first()
  return row ? JSON.parse(row.value) : null
}

export async function setSetting(db, key, value) {
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, JSON.stringify(value))
    .run()
}
