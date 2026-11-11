import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BufferPost, DbConnection } from './types.ts';

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string, migrate = true) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:' && process.platform !== 'win32') chmodSync(path, 0o600);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
    if (migrate) {
      this.db.exec(readFileSync(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8'));
      this.db.exec(readFileSync(new URL('../migrations/002_concurrency_hardening.sql', import.meta.url), 'utf8'));
      this.db.exec(readFileSync(new URL('../migrations/003_buffer_reauthorization.sql', import.meta.url), 'utf8'));
      this.minimizeLegacyPostData();
      this.purgeExpiredData();
    }
  }

  close(): void { this.db.close(); }

  healthCheck(): { ready: boolean; schemaVersion: number } {
    const foreignKeys = this.db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    const migration = this.db.prepare('SELECT MAX(version) version FROM schema_migrations').get() as { version: number | null };
    const database = this.db.prepare('PRAGMA quick_check(1)').get() as { quick_check: string };
    const schemaVersion = migration.version ?? 0;
    return { ready: foreignKeys.foreign_keys === 1 && database.quick_check === 'ok' && schemaVersion === 3, schemaVersion };
  }

  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createTenant(id: string): void {
    this.db.prepare('INSERT OR IGNORE INTO tenants(id, created_at) VALUES (?, ?)').run(id, new Date().toISOString());
  }

  createSession(input: { idHash: string; tenantId: string; csrfHash: string; expiresAt: string }): void {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO browser_sessions(id_hash, tenant_id, csrf_hash, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)` ).run(input.idHash, input.tenantId, input.csrfHash, now, input.expiresAt);
  }

  getSession(idHash: string): Record<string, unknown> | undefined {
    return this.db.prepare('SELECT * FROM browser_sessions WHERE id_hash = ? AND expires_at > ?')
      .get(idHash, new Date().toISOString()) as Record<string, unknown> | undefined;
  }

  touchSession(idHash: string, expiresAt: string): boolean {
    return this.db.prepare('UPDATE browser_sessions SET expires_at=? WHERE id_hash=? AND expires_at>?')
      .run(expiresAt, idHash, new Date().toISOString()).changes === 1;
  }

  setOAuthSession(idHash: string, stateHash: string, verifierCiphertext: string, expiresAt: string,
    reconnect?: { connectionId: string; expectedTokenVersion: number }): void {
    this.transaction(() => {
      const session = this.db.prepare(`UPDATE browser_sessions SET oauth_state_hash=?,pkce_verifier_ciphertext=?,oauth_expires_at=?
        WHERE id_hash=? AND expires_at>?`).run(stateHash, verifierCiphertext, expiresAt, idHash, new Date().toISOString());
      if (session.changes !== 1) throw new Error('The browser session is unavailable or expired');
      this.db.prepare('DELETE FROM oauth_reauthorization_flows WHERE session_id_hash=?').run(idHash);
      if (!reconnect) return;
      const inserted = this.db.prepare(`INSERT INTO oauth_reauthorization_flows
        (session_id_hash,connection_id,expected_token_version,created_at,expires_at)
        SELECT ?,c.id,c.token_version,?,? FROM browser_sessions s JOIN buffer_connections c ON c.tenant_id=s.tenant_id
        WHERE s.id_hash=? AND c.id=? AND c.token_version=? AND c.status='reauthorization_required'`)
        .run(idHash, new Date().toISOString(), expiresAt, idHash, reconnect.connectionId, reconnect.expectedTokenVersion);
      if (inserted.changes !== 1) throw new Error('The Buffer connection is no longer eligible for reauthorization');
    });
  }

  consumeOAuthSession(idHash: string, stateHash: string): { oauth_state_hash: string; pkce_verifier_ciphertext: string;
    connection_id: string | null; expected_token_version: number | null } | undefined {
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT s.oauth_state_hash,s.pkce_verifier_ciphertext,r.connection_id,r.expected_token_version
        FROM browser_sessions s LEFT JOIN oauth_reauthorization_flows r ON r.session_id_hash=s.id_hash
        WHERE s.id_hash=? AND s.oauth_state_hash=? AND s.oauth_expires_at>? AND (r.expires_at IS NULL OR r.expires_at>?)`)
        .get(idHash, stateHash, new Date().toISOString(), new Date().toISOString()) as { oauth_state_hash: string;
          pkce_verifier_ciphertext: string; connection_id: string | null; expected_token_version: number | null } | undefined;
      if (row) {
        this.db.prepare(`UPDATE browser_sessions SET oauth_state_hash=NULL,pkce_verifier_ciphertext=NULL,oauth_expires_at=NULL
          WHERE id_hash=?`).run(idHash);
        this.db.prepare('DELETE FROM oauth_reauthorization_flows WHERE session_id_hash=?').run(idHash);
      }
      return row;
    });
  }

  upsertConnection(input: Omit<DbConnection, 'token_version' | 'status'>): string {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO buffer_connections
      (id, tenant_id, buffer_account_id, access_token_ciphertext, refresh_token_ciphertext, access_expires_at, scopes, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
      ON CONFLICT(tenant_id, buffer_account_id) DO UPDATE SET
        access_token_ciphertext=excluded.access_token_ciphertext,
        refresh_token_ciphertext=excluded.refresh_token_ciphertext,
        access_expires_at=excluded.access_expires_at, scopes=excluded.scopes,
        status='active', token_version=buffer_connections.token_version+1, updated_at=excluded.updated_at`)
      .run(input.id, input.tenant_id, input.buffer_account_id, input.access_token_ciphertext,
        input.refresh_token_ciphertext, input.access_expires_at, input.scopes, now, now);
    const row = this.db.prepare('SELECT id FROM buffer_connections WHERE tenant_id=? AND buffer_account_id=?')
      .get(input.tenant_id, input.buffer_account_id) as { id: string };
    return row.id;
  }

  getConnection(tenantId: string, connectionId?: string): DbConnection | undefined {
    const sql = connectionId
      ? 'SELECT * FROM buffer_connections WHERE tenant_id=? AND id=?'
      : 'SELECT * FROM buffer_connections WHERE tenant_id=? ORDER BY created_at LIMIT 1';
    return this.db.prepare(sql).get(...(connectionId ? [tenantId, connectionId] : [tenantId])) as DbConnection | undefined;
  }

  requireAuthenticatedTenantConnection(tenantId: string, now = new Date()): DbConnection {
    if (!tenantId.trim()) throw new Error('An explicit authenticated tenant is required');
    const session = this.db.prepare(`SELECT 1 present FROM browser_sessions
      WHERE tenant_id=? AND expires_at>? LIMIT 1`).get(tenantId, now.toISOString());
    if (!session) throw new Error('The selected tenant has no unexpired browser session');
    const connections = this.db.prepare(`SELECT * FROM buffer_connections
      WHERE tenant_id=? AND status='active' ORDER BY created_at`).all(tenantId) as unknown as DbConnection[];
    if (connections.length !== 1) {
      throw new Error(`Read-only verification requires exactly one active connection for the authenticated tenant; found ${connections.length}`);
    }
    return connections[0];
  }

  rotateTokens(connectionId: string, expectedVersion: number, access: string, refresh: string, expiresAt: string, scopes: string): boolean {
    const result = this.db.prepare(`UPDATE buffer_connections SET access_token_ciphertext=?, refresh_token_ciphertext=?,
      access_expires_at=?, scopes=?, token_version=token_version+1, status='active', updated_at=?
      WHERE id=? AND token_version=?`).run(access, refresh, expiresAt, scopes, new Date().toISOString(), connectionId, expectedVersion);
    return result.changes === 1;
  }

  reauthorizeConnection(input: { tenantId: string; connectionId: string; expectedAccountId: string; expectedVersion: number;
    access: string; refresh: string; expiresAt: string; scopes: string; now?: Date }): boolean {
    const now = input.now ?? new Date();
    return this.db.prepare(`UPDATE buffer_connections SET access_token_ciphertext=?,refresh_token_ciphertext=?,
      access_expires_at=?,scopes=?,token_version=token_version+1,status='active',updated_at=?
      WHERE tenant_id=? AND id=? AND buffer_account_id=? AND token_version=? AND status='reauthorization_required'`)
      .run(input.access, input.refresh, input.expiresAt, input.scopes, now.toISOString(), input.tenantId,
        input.connectionId, input.expectedAccountId, input.expectedVersion).changes === 1;
  }

  acquireTokenRefreshClaim(connectionId: string, tokenVersion: number, ownerId: string, now: Date, expiresAt: Date):
    'acquired' | 'newer_tokens' | 'in_progress' | 'uncertain' | 'expired_uncertain' {
    return this.transaction(() => {
      const connection = this.db.prepare('SELECT token_version,status FROM buffer_connections WHERE id=?')
        .get(connectionId) as { token_version: number; status: string } | undefined;
      if (!connection || connection.status !== 'active') return 'uncertain';
      if (connection.token_version !== tokenVersion) return 'newer_tokens';
      const claim = this.db.prepare('SELECT token_version,state,expires_at FROM token_refresh_claims WHERE connection_id=?')
        .get(connectionId) as { token_version: number; state: string; expires_at: string } | undefined;
      if (claim?.token_version === tokenVersion) {
        if (claim.state === 'claimed' && claim.expires_at <= now.toISOString()) {
          const replaced = this.db.prepare(`UPDATE token_refresh_claims SET owner_id=?,state='claimed',claimed_at=?,expires_at=?,
            request_started_at=NULL,completed_at=NULL WHERE connection_id=? AND token_version=? AND state='claimed' AND expires_at<=?`)
            .run(ownerId, now.toISOString(), expiresAt.toISOString(), connectionId, tokenVersion, now.toISOString());
          return replaced.changes === 1 ? 'acquired' : 'in_progress';
        }
        if (claim.state === 'claimed') return 'in_progress';
        return claim.expires_at <= now.toISOString() && claim.state !== 'completed' ? 'expired_uncertain' : 'uncertain';
      }
      if (claim && claim.token_version > tokenVersion) return 'newer_tokens';
      this.db.prepare(`INSERT INTO token_refresh_claims(connection_id,token_version,owner_id,state,claimed_at,expires_at)
        VALUES(?,?,?,'claimed',?,?) ON CONFLICT(connection_id) DO UPDATE SET token_version=excluded.token_version,
        owner_id=excluded.owner_id,state='claimed',claimed_at=excluded.claimed_at,expires_at=excluded.expires_at,
        request_started_at=NULL,completed_at=NULL`)
        .run(connectionId, tokenVersion, ownerId, now.toISOString(), expiresAt.toISOString());
      return 'acquired';
    });
  }

  startTokenRefresh(connectionId: string, tokenVersion: number, ownerId: string, now: Date, expiresAt: Date): boolean {
    return this.db.prepare(`UPDATE token_refresh_claims SET state='request_started',request_started_at=?,expires_at=?
      WHERE connection_id=? AND token_version=? AND owner_id=? AND state='claimed' AND expires_at>?`)
      .run(now.toISOString(), expiresAt.toISOString(), connectionId, tokenVersion, ownerId, now.toISOString()).changes === 1;
  }

  commitTokenRefresh(input: { connectionId: string; expectedVersion: number; ownerId: string; access: string; refresh: string;
    expiresAt: string; scopes: string; now?: Date }): boolean {
    return this.transaction(() => {
      const now = input.now ?? new Date();
      const claim = this.db.prepare(`SELECT 1 present FROM token_refresh_claims
        WHERE connection_id=? AND token_version=? AND owner_id=? AND state='request_started'`)
        .get(input.connectionId, input.expectedVersion, input.ownerId);
      if (!claim) return false;
      const updated = this.db.prepare(`UPDATE buffer_connections SET access_token_ciphertext=?,refresh_token_ciphertext=?,
        access_expires_at=?,scopes=?,token_version=token_version+1,status='active',updated_at=?
        WHERE id=? AND token_version=?`).run(input.access, input.refresh, input.expiresAt, input.scopes,
        now.toISOString(), input.connectionId, input.expectedVersion);
      if (updated.changes !== 1) return false;
      this.db.prepare(`UPDATE token_refresh_claims SET state='completed',completed_at=?
        WHERE connection_id=? AND token_version=? AND owner_id=?`).run(now.toISOString(), input.connectionId, input.expectedVersion, input.ownerId);
      return true;
    });
  }

  markTokenRefreshAmbiguous(connectionId: string, tokenVersion: number, ownerId: string, now = new Date()): void {
    this.transaction(() => {
      this.db.prepare(`UPDATE token_refresh_claims SET state='ambiguous',completed_at=?
        WHERE connection_id=? AND token_version=? AND owner_id=? AND state='request_started'`)
        .run(now.toISOString(), connectionId, tokenVersion, ownerId);
      this.db.prepare(`UPDATE buffer_connections SET status='reauthorization_required',updated_at=?
        WHERE id=? AND token_version=?`).run(now.toISOString(), connectionId, tokenVersion);
    });
  }

  claimEditIntent(tenantId: string, intentId: string, postId: string, claimId: string, now = new Date()): Record<string, string> | undefined {
    return this.transaction(() => {
      const intent = this.db.prepare(`SELECT * FROM edit_intents WHERE id=? AND tenant_id=? AND post_id=?
        AND status='pending' AND expires_at>?`).get(intentId, tenantId, postId, now.toISOString()) as Record<string, string> | undefined;
      if (!intent) return undefined;
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO edit_intent_claims
        (intent_id,tenant_id,claim_id,state,claimed_at,expires_at) VALUES(?,?,?,'claimed',?,?)`)
        .run(intentId, tenantId, claimId, now.toISOString(), intent.expires_at);
      if (inserted.changes !== 1) {
        const expired = this.db.prepare(`UPDATE edit_intent_claims SET state='failed',completed_at=?
          WHERE intent_id=? AND tenant_id=? AND state='claimed' AND expires_at<=?`)
          .run(now.toISOString(), intentId, tenantId, now.toISOString());
        if (expired.changes === 1) this.db.prepare(`UPDATE edit_intents SET status='aborted_stale',outcome_json=?
          WHERE id=? AND tenant_id=? AND status='pending'`)
          .run(JSON.stringify({ reason: 'Approval claim expired before mutation; a new intent is required' }), intentId, tenantId);
        const uncertain = this.db.prepare(`UPDATE edit_intent_claims SET state='ambiguous',completed_at=?
          WHERE intent_id=? AND tenant_id=? AND state='mutation_started' AND expires_at<=?`)
          .run(now.toISOString(), intentId, tenantId, now.toISOString());
        if (uncertain.changes === 1) this.db.prepare(`UPDATE edit_intents SET status='ambiguous',outcome_json=?
          WHERE id=? AND tenant_id=? AND status='pending'`)
          .run(JSON.stringify({ reason: 'The mutation-start claim expired; Buffer outcome requires manual verification and must not be replayed' }), intentId, tenantId);
      }
      return inserted.changes === 1 ? intent : undefined;
    });
  }

  startEditMutation(intentId: string, claimId: string, now = new Date()): boolean {
    return this.db.prepare(`UPDATE edit_intent_claims SET state='mutation_started',mutation_started_at=?
      WHERE intent_id=? AND claim_id=? AND state='claimed' AND expires_at>?`)
      .run(now.toISOString(), intentId, claimId, now.toISOString()).changes === 1;
  }

  finishEditClaim(intentId: string, claimId: string, state: 'completed' | 'ambiguous' | 'failed', now = new Date()): boolean {
    return this.db.prepare(`UPDATE edit_intent_claims SET state=?,completed_at=?
      WHERE intent_id=? AND claim_id=? AND state IN ('claimed','mutation_started')`)
      .run(state, now.toISOString(), intentId, claimId).changes === 1;
  }

  requireReauth(connectionId: string): void {
    this.db.prepare(`UPDATE buffer_connections SET status='reauthorization_required', updated_at=? WHERE id=?`)
      .run(new Date().toISOString(), connectionId);
  }

  requireReauthIfVersion(connectionId: string, expectedVersion: number): boolean {
    return this.db.prepare(`UPDATE buffer_connections SET status='reauthorization_required',updated_at=?
      WHERE id=? AND token_version=?`).run(new Date().toISOString(), connectionId, expectedVersion).changes === 1;
  }

  disconnectConnection(tenantId: string, connectionId: string): boolean {
    const result = this.db.prepare('DELETE FROM buffer_connections WHERE tenant_id=? AND id=?').run(tenantId, connectionId);
    return result.changes === 1;
  }

  deleteTenant(tenantId: string): boolean {
    const result = this.db.prepare('DELETE FROM tenants WHERE id=?').run(tenantId);
    return result.changes === 1;
  }

  purgeExpiredData(now = new Date()): void {
    const iso = now.toISOString();
    const cacheCutoff = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
    const evidenceCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60_000).toISOString();
    this.transaction(() => {
      this.db.prepare('DELETE FROM edit_intents WHERE expires_at <= ?').run(iso);
      this.db.prepare('DELETE FROM browser_sessions WHERE expires_at <= ?').run(iso);
      this.db.prepare('DELETE FROM posts WHERE synced_at < ?').run(cacheCutoff);
      this.db.prepare('DELETE FROM channels WHERE synced_at < ?').run(cacheCutoff);
      this.db.prepare('DELETE FROM organizations WHERE synced_at < ?').run(cacheCutoff);
      this.db.prepare('DELETE FROM post_media_checks WHERE checked_at < ?').run(cacheCutoff);
      this.db.prepare('DELETE FROM evidence_events WHERE created_at < ?').run(evidenceCutoff);
      // Without an unexpired signed session this browser account cannot be recovered.
      // Cascading the tenant removes any remaining encrypted credentials and records.
      this.db.prepare('DELETE FROM tenants WHERE NOT EXISTS (SELECT 1 FROM browser_sessions s WHERE s.tenant_id=tenants.id)').run();
    });
  }

  private minimizeLegacyPostData(): void {
    // Older Phase 1 databases stored post copy and asset URLs that the dashboard never used.
    // Retain only a count in sanitized_json and remove the legacy asset rows.
    this.transaction(() => {
      this.db.prepare(`UPDATE posts SET text_content='', sanitized_json=json_object('assetCount',
        (SELECT COUNT(*) FROM assets a WHERE a.tenant_id=posts.tenant_id AND a.post_id=posts.id))
        WHERE text_content<>'' OR sanitized_json NOT LIKE '{"assetCount":%'`).run();
      this.db.prepare('DELETE FROM assets').run();
    });
  }

  replaceDiscovery(tenantId: string, connectionId: string, organizations: Array<{ id: string; name: string; channels: Array<Record<string, unknown>> }>): void {
    const now = new Date().toISOString();
    this.transaction(() => {
      this.db.prepare('DELETE FROM channels WHERE tenant_id=? AND connection_id=?').run(tenantId, connectionId);
      this.db.prepare('DELETE FROM organizations WHERE tenant_id=? AND connection_id=?').run(tenantId, connectionId);
      const orgStmt = this.db.prepare('INSERT INTO organizations(id,tenant_id,connection_id,name,synced_at) VALUES(?,?,?,?,?)');
      const channelStmt = this.db.prepare(`INSERT INTO channels(id,tenant_id,connection_id,organization_id,name,display_name,service,is_disconnected,is_locked,synced_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`);
      for (const org of organizations) {
        orgStmt.run(org.id, tenantId, connectionId, org.name, now);
        for (const channel of org.channels) channelStmt.run(String(channel.id), tenantId, connectionId, org.id, String(channel.name),
          channel.displayName == null ? null : String(channel.displayName), String(channel.service), channel.isDisconnected ? 1 : 0, channel.isLocked ? 1 : 0, now);
      }
    });
  }

  replacePosts(tenantId: string, connectionId: string, organizationId: string, posts: BufferPost[]): void {
    const now = new Date().toISOString();
    this.transaction(() => {
      this.db.prepare('DELETE FROM posts WHERE tenant_id=? AND connection_id=? AND organization_id=?').run(tenantId, connectionId, organizationId);
      const postStmt = this.db.prepare(`INSERT INTO posts(id,tenant_id,connection_id,organization_id,channel_id,status,due_at,share_mode,scheduling_type,text_content,updated_at_remote,sanitized_json,synced_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,id) DO UPDATE SET channel_id=excluded.channel_id,status=excluded.status,due_at=excluded.due_at,
        share_mode=excluded.share_mode,scheduling_type=excluded.scheduling_type,text_content=excluded.text_content,updated_at_remote=excluded.updated_at_remote,
        sanitized_json=excluded.sanitized_json,synced_at=excluded.synced_at`);
      for (const post of posts) {
        postStmt.run(post.id, tenantId, connectionId, organizationId, post.channelId, post.status, post.dueAt, post.shareMode,
          post.schedulingType, '', post.updatedAt, JSON.stringify({ assetCount: post.assets.length }), now);
      }
    });
  }

  removePostsOutsideOrganizations(tenantId: string, connectionId: string, organizationIds: string[]): void {
    if (organizationIds.length === 0) {
      this.db.prepare('DELETE FROM posts WHERE tenant_id=? AND connection_id=?').run(tenantId, connectionId);
      return;
    }
    const placeholders = organizationIds.map(() => '?').join(',');
    this.db.prepare(`DELETE FROM posts WHERE tenant_id=? AND connection_id=? AND organization_id NOT IN (${placeholders})`)
      .run(tenantId, connectionId, ...organizationIds);
  }

  listDashboard(tenantId: string): { channels: unknown[]; posts: unknown[] } {
    return {
      channels: this.db.prepare('SELECT id,name,display_name,service,is_disconnected,is_locked FROM channels WHERE tenant_id=? ORDER BY service,name').all(tenantId),
      posts: this.db.prepare(`SELECT p.id,p.channel_id,p.status,p.due_at,p.synced_at,
        COALESCE(json_extract(p.sanitized_json, '$.assetCount'), 0) asset_count,
        c.display_name channel_display_name,c.name channel_name,c.service channel_service,
        m.status media_status,m.checked_count,m.summary_json,m.checked_at
        FROM posts p
        LEFT JOIN channels c ON c.tenant_id=p.tenant_id AND c.id=p.channel_id
        LEFT JOIN post_media_checks m ON m.tenant_id=p.tenant_id AND m.post_id=p.id
        WHERE p.tenant_id=? ORDER BY p.due_at`).all(tenantId),
    };
  }

  getDashboardPost(tenantId: string, connectionId: string, postId: string): Record<string, unknown> | undefined {
    return this.db.prepare(`SELECT p.id,p.channel_id,p.status,p.due_at,p.synced_at,
      COALESCE(json_extract(p.sanitized_json, '$.assetCount'), 0) asset_count,
      c.display_name channel_display_name,c.name channel_name,c.service channel_service,
      m.status media_status,m.checked_count,m.summary_json,m.checked_at
      FROM posts p
      LEFT JOIN channels c ON c.tenant_id=p.tenant_id AND c.id=p.channel_id
      LEFT JOIN post_media_checks m ON m.tenant_id=p.tenant_id AND m.post_id=p.id
      WHERE p.tenant_id=? AND p.connection_id=? AND p.id=?`).get(tenantId, connectionId, postId) as Record<string, unknown> | undefined;
  }

  saveMediaCheck(input: { tenantId: string; connectionId: string; postId: string; status: 'ready' | 'confirmed_problem' | 'could_not_verify' | 'unsupported_file'; checkedCount: number; summary: unknown; requestId?: string; checkedAt?: string }): void {
    this.db.prepare(`INSERT INTO post_media_checks
      (tenant_id,connection_id,post_id,status,checked_count,summary_json,request_id,checked_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,post_id) DO UPDATE SET
      connection_id=excluded.connection_id,status=excluded.status,checked_count=excluded.checked_count,
      summary_json=excluded.summary_json,request_id=excluded.request_id,checked_at=excluded.checked_at`)
      .run(input.tenantId, input.connectionId, input.postId, input.status, input.checkedCount,
        JSON.stringify(input.summary), input.requestId ?? null, input.checkedAt ?? new Date().toISOString());
  }

  hasFreshConfirmedProblem(tenantId: string, connectionId: string, postId: string, now = new Date()): boolean {
    return this.getFreshConfirmedProblemPositions(tenantId, connectionId, postId, now).length > 0;
  }

  getFreshConfirmedProblemPositions(tenantId: string, connectionId: string, postId: string, now = new Date()): number[] {
    return this.getFreshConfirmedProblemEvidence(tenantId, connectionId, postId, now)?.summary.map((item) => item.position) ?? [];
  }

  getFreshConfirmedProblemEvidence(tenantId: string, connectionId: string, postId: string, now = new Date()): {
    checkedAt: string;
    summary: Array<{ position: number; label: string; detail?: string; httpStatus?: number }>;
  } | undefined {
    const cutoff = new Date(now.getTime() - 10 * 60_000).toISOString();
    const row = this.db.prepare(`SELECT summary_json,checked_at FROM post_media_checks
      WHERE tenant_id=? AND connection_id=? AND post_id=? AND status='confirmed_problem' AND checked_at>?`)
      .get(tenantId, connectionId, postId, cutoff) as { summary_json: string; checked_at: string } | undefined;
    if (!row) return undefined;
    const summary = (JSON.parse(row.summary_json) as Array<{ position?: unknown; label?: unknown; detail?: unknown; httpStatus?: unknown }>)
      .filter((item) => item.label === 'CONFIRMED PROBLEM' && Number.isInteger(item.position))
      .map((item) => ({ position: Number(item.position), label: 'CONFIRMED PROBLEM',
        detail: typeof item.detail === 'string' ? item.detail : undefined,
        httpStatus: typeof item.httpStatus === 'number' ? item.httpStatus : undefined }));
    return summary.length ? { checkedAt: row.checked_at, summary } : undefined;
  }

  hasCachedPost(tenantId: string, connectionId: string, postId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 present FROM posts WHERE tenant_id=? AND connection_id=? AND id=?')
      .get(tenantId, connectionId, postId));
  }

  addEvidence(input: { id: string; tenantId: string; operation: string; outcome: string; requestId?: string; sanitized: unknown }): void {
    this.db.prepare(`INSERT INTO evidence_events(id,tenant_id,operation,outcome,request_id,sanitized_json,created_at) VALUES(?,?,?,?,?,?,?)`)
      .run(input.id, input.tenantId, input.operation, input.outcome, input.requestId ?? null, JSON.stringify(input.sanitized), new Date().toISOString());
  }
}
