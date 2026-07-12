-- Episodes + settings, mirroring the Postgres store. `data` is the full
-- episode object as JSON text (same shape the SPA consumes).
CREATE TABLE IF NOT EXISTS episodes (
  id          TEXT PRIMARY KEY,
  hn_id       TEXT NOT NULL,
  mode        TEXT NOT NULL DEFAULT 'podcast',
  status      TEXT NOT NULL,
  title       TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  data        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS episodes_hn_mode_idx ON episodes (hn_id, mode);
CREATE INDEX IF NOT EXISTS episodes_created_idx ON episodes (created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
