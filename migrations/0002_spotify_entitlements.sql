CREATE TABLE IF NOT EXISTS spotify_oauth_states (
  state       TEXT PRIMARY KEY,
  return_to   TEXT NOT NULL DEFAULT '/',
  expires_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS spotify_users (
  spotify_user_id      TEXT PRIMARY KEY,
  display_name         TEXT,
  follows_show         INTEGER NOT NULL DEFAULT 0,
  verified_at          TEXT NOT NULL,
  generation_used_at   TEXT,
  generated_hn_id      TEXT
);

CREATE TABLE IF NOT EXISTS spotify_sessions (
  token_hash       TEXT PRIMARY KEY,
  spotify_user_id  TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (spotify_user_id) REFERENCES spotify_users(spotify_user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS spotify_sessions_user_idx ON spotify_sessions (spotify_user_id);
