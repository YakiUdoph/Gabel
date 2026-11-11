PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, '2026-11-06T00:00:00.000Z');

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS browser_sessions (
  id_hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  csrf_hash TEXT NOT NULL,
  oauth_state_hash TEXT,
  pkce_verifier_ciphertext TEXT,
  oauth_expires_at TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_tenant ON browser_sessions(tenant_id);

CREATE TABLE IF NOT EXISTS buffer_connections (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  buffer_account_id TEXT NOT NULL,
  access_token_ciphertext TEXT NOT NULL,
  refresh_token_ciphertext TEXT,
  access_expires_at TEXT NOT NULL,
  scopes TEXT NOT NULL,
  token_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK(status IN ('active','reauthorization_required')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(tenant_id, buffer_account_id)
);
CREATE INDEX IF NOT EXISTS idx_connections_tenant ON buffer_connections(tenant_id);

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES buffer_connections(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS channels (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES buffer_connections(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  display_name TEXT,
  service TEXT NOT NULL,
  is_disconnected INTEGER NOT NULL,
  is_locked INTEGER NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES buffer_connections(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  status TEXT NOT NULL,
  due_at TEXT,
  share_mode TEXT NOT NULL,
  scheduling_type TEXT,
  text_content TEXT NOT NULL,
  updated_at_remote TEXT NOT NULL,
  sanitized_json TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_posts_tenant_channel ON posts(tenant_id, channel_id);

CREATE TABLE IF NOT EXISTS post_media_checks (
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES buffer_connections(id) ON DELETE CASCADE,
  post_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ready','confirmed_problem','could_not_verify','unsupported_file')),
  checked_count INTEGER NOT NULL,
  summary_json TEXT NOT NULL,
  request_id TEXT,
  checked_at TEXT NOT NULL,
  PRIMARY KEY(tenant_id, post_id)
);
CREATE INDEX IF NOT EXISTS idx_media_checks_connection ON post_media_checks(tenant_id, connection_id, checked_at);

CREATE TABLE IF NOT EXISTS assets (
  tenant_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  asset_id TEXT,
  type TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  source_url TEXT NOT NULL,
  thumbnail_url TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  PRIMARY KEY(tenant_id, post_id, position),
  FOREIGN KEY(tenant_id, post_id) REFERENCES posts(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS edit_intents (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES buffer_connections(id) ON DELETE CASCADE,
  post_id TEXT NOT NULL,
  before_json TEXT NOT NULL,
  intended_assets_json TEXT NOT NULL,
  before_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','aborted_stale','ambiguous','confirmed','failed')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  outcome_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_edits_tenant ON edit_intents(tenant_id);

CREATE TABLE IF NOT EXISTS evidence_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('success','failure','ambiguous','not_tested')),
  request_id TEXT,
  sanitized_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
