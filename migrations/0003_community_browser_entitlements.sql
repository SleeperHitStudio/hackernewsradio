CREATE TABLE IF NOT EXISTS community_browser_entitlements (
  token_hash          TEXT PRIMARY KEY,
  confirmed_at        TEXT NOT NULL,
  generation_used_at  TEXT,
  generated_hn_id     TEXT
);

