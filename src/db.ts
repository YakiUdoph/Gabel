import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { BufferPost, DbConnection } from './types.ts';

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string, migrate = true) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    if (migrate) {
      this.db.exec(readFileSync(resolve('migrations/001_initial.sql'), 'utf8'));
      this.minimizeLegacyPostData();
      this.purgeExpiredData();
    }
  }

  close(): void { this.db.close(); }

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

  setOAuthSession(idHash: string, stateHash: string, verifierCiphertext: string, expiresAt: string): void {
    this.db.prepare(`UPDATE browser_sessions SET oauth_state_hash = ?, pkce_verifier_ciphertext = ?, oauth_expires_at = ?
      WHERE id_hash = ?`).run(stateHash, verifierCiphertext, expiresAt, idHash);
  }

  consumeOAuthSession(idHash: string, stateHash: string): { oauth_state_hash: string; pkce_verifier_ciphertext: string } | undefined {
    return this.transaction(() => {
      const row = this.db.prepare(`SELECT oauth_state_hash, pkce_verifier_ciphertext FROM browser_sessions
        WHERE id_hash = ? AND oauth_state_hash = ? AND oauth_expires_at > ?`).get(idHash, stateHash, new Date().toISOString()) as { oauth_state_hash: string; pkce_verifier_ciphertext: string } | undefined;
      if (row) this.db.prepare(`UPDATE browser_sessions SET oauth_state_hash = NULL, pkce_verifier_ciphertext = NULL,
        oauth_expires_at = NULL WHERE id_hash = ?`).run(idHash);
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

  rotateTokens(connectionId: string, expectedVersion: number, access: string, refresh: string, expiresAt: string, scopes: string): boolean {
    const result = this.db.prepare(`UPDATE buffer_connections SET access_token_ciphertext=?, refresh_token_ciphertext=?,
      access_expires_at=?, scopes=?, token_version=token_version+1, status='active', updated_at=?
      WHERE id=? AND token_version=?`).run(access, refresh, expiresAt, scopes, new Date().toISOString(), connectionId, expectedVersion);
    return result.changes === 1;
  }

  requireReauth(connectionId: string): void {
    this.db.prepare(`UPDATE buffer_connections SET status='reauthorization_required', updated_at=? WHERE id=?`)
      .run(new Date().toISOString(), connectionId);
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
      this.db.prepare('DELETE FROM evidence_events WHERE created_at < ?').run(evidenceCutoff);
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
      posts: this.db.prepare(`SELECT p.id,p.channel_id,p.status,p.due_at,
        COALESCE(json_extract(p.sanitized_json, '$.assetCount'), 0) asset_count
        FROM posts p WHERE p.tenant_id=? ORDER BY p.due_at`).all(tenantId),
    };
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
