CREATE UNIQUE INDEX IF NOT EXISTS idx_edit_intents_id_tenant ON edit_intents(id, tenant_id);

CREATE TABLE IF NOT EXISTS edit_intent_claims (
  intent_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  claim_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('claimed','mutation_started','completed','ambiguous','failed')),
  claimed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  mutation_started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY(intent_id, tenant_id) REFERENCES edit_intents(id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_edit_claims_tenant ON edit_intent_claims(tenant_id, claimed_at);

CREATE TABLE IF NOT EXISTS token_refresh_claims (
  connection_id TEXT PRIMARY KEY REFERENCES buffer_connections(id) ON DELETE CASCADE,
  token_version INTEGER NOT NULL,
  owner_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('claimed','request_started','completed','ambiguous')),
  claimed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  request_started_at TEXT,
  completed_at TEXT
);

INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (2, '2026-11-07T00:00:00.000Z');
