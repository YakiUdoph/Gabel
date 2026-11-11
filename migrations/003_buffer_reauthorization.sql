PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS oauth_reauthorization_flows (
  session_id_hash TEXT PRIMARY KEY REFERENCES browser_sessions(id_hash) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES buffer_connections(id) ON DELETE CASCADE,
  expected_token_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_reauthorization_connection
  ON oauth_reauthorization_flows(connection_id, expected_token_version);

INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (3, '2026-11-07T00:00:00.000Z');
