import { readFile } from 'node:fs/promises';
import { Pool, neon, neonConfig, type PoolClient, type QueryResultRow } from '@neondatabase/serverless';
import ws from 'ws';
import type { BufferPost, DbConnection } from './types.ts';

type EditStatus = 'pending' | 'aborted_stale' | 'ambiguous' | 'confirmed' | 'failed';

neonConfig.webSocketConstructor = ws;

export class PostgresStore {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 4, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 20_000 });
    this.connectionString = connectionString;
  }

  private readonly connectionString: string;

  async migrate(): Promise<void> {
    const sql = await readFile(new URL('../migrations/postgres/001_initial.sql', import.meta.url), 'utf8');
    const statements = sql.split(/;\s*(?:\r?\n|$)/).map((statement) => statement.trim()).filter(Boolean);
    const client = neon(this.connectionString);
    await client.transaction((tx) => statements.map((statement) => tx.query(statement, [])));
  }

  async close(): Promise<void> { await this.pool.end(); }

  private async one<T extends QueryResultRow>(text: string, values: unknown[] = []): Promise<T | undefined> {
    return (await this.pool.query<T>(text, values)).rows[0];
  }

  private async tx<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async healthCheck(): Promise<{ ready: boolean; schemaVersion: number }> {
    const row = await this.one<{ version: number | null }>('SELECT MAX(version) version FROM schema_migrations');
    const schemaVersion = Number(row?.version ?? 0);
    return { ready: schemaVersion === 1, schemaVersion };
  }

  async createTenant(id: string): Promise<void> {
    await this.pool.query('INSERT INTO tenants(id,created_at) VALUES($1,$2) ON CONFLICT(id) DO NOTHING', [id, new Date().toISOString()]);
  }

  async createSession(input: { idHash: string; tenantId: string; csrfHash: string; expiresAt: string }): Promise<void> {
    await this.pool.query(`INSERT INTO browser_sessions(id_hash,tenant_id,csrf_hash,created_at,expires_at) VALUES($1,$2,$3,$4,$5)`,
      [input.idHash, input.tenantId, input.csrfHash, new Date().toISOString(), input.expiresAt]);
  }

  async getSession(idHash: string): Promise<Record<string, unknown> | undefined> {
    return this.one('SELECT * FROM browser_sessions WHERE id_hash=$1 AND expires_at>$2', [idHash, new Date().toISOString()]);
  }

  async touchSession(idHash: string, expiresAt: string): Promise<boolean> {
    return (await this.pool.query('UPDATE browser_sessions SET expires_at=$1 WHERE id_hash=$2 AND expires_at>$3',
      [expiresAt, idHash, new Date().toISOString()])).rowCount === 1;
  }

  async setOAuthSession(idHash: string, stateHash: string, verifierCiphertext: string, expiresAt: string,
    reconnect?: { connectionId: string; expectedTokenVersion: number }): Promise<void> {
    await this.tx(async (client) => {
      const session = await client.query(`UPDATE browser_sessions SET oauth_state_hash=$1,pkce_verifier_ciphertext=$2,oauth_expires_at=$3
        WHERE id_hash=$4 AND expires_at>$5`, [stateHash, verifierCiphertext, expiresAt, idHash, new Date().toISOString()]);
      if (session.rowCount !== 1) throw new Error('The browser session is unavailable or expired');
      await client.query('DELETE FROM oauth_reauthorization_flows WHERE session_id_hash=$1', [idHash]);
      if (!reconnect) return;
      const inserted = await client.query(`INSERT INTO oauth_reauthorization_flows
        (session_id_hash,connection_id,expected_token_version,created_at,expires_at)
        SELECT $1,c.id,c.token_version,$2,$3 FROM browser_sessions s JOIN buffer_connections c ON c.tenant_id=s.tenant_id
        WHERE s.id_hash=$1 AND c.id=$4 AND c.token_version=$5 AND c.status='reauthorization_required'`,
        [idHash, new Date().toISOString(), expiresAt, reconnect.connectionId, reconnect.expectedTokenVersion]);
      if (inserted.rowCount !== 1) throw new Error('The Buffer connection is no longer eligible for reauthorization');
    });
  }

  async consumeOAuthSession(idHash: string, stateHash: string): Promise<{ oauth_state_hash: string; pkce_verifier_ciphertext: string;
    connection_id: string | null; expected_token_version: number | null } | undefined> {
    return this.tx(async (client) => {
      const now = new Date().toISOString();
      const result = await client.query<{ oauth_state_hash: string; pkce_verifier_ciphertext: string; connection_id: string | null;
        expected_token_version: number | null }>(`SELECT s.oauth_state_hash,s.pkce_verifier_ciphertext,r.connection_id,r.expected_token_version
        FROM browser_sessions s LEFT JOIN oauth_reauthorization_flows r ON r.session_id_hash=s.id_hash
        WHERE s.id_hash=$1 AND s.oauth_state_hash=$2 AND s.oauth_expires_at>$3 AND (r.expires_at IS NULL OR r.expires_at>$3) FOR UPDATE OF s`,
        [idHash, stateHash, now]);
      const row = result.rows[0];
      if (row) {
        await client.query(`UPDATE browser_sessions SET oauth_state_hash=NULL,pkce_verifier_ciphertext=NULL,oauth_expires_at=NULL WHERE id_hash=$1`, [idHash]);
        await client.query('DELETE FROM oauth_reauthorization_flows WHERE session_id_hash=$1', [idHash]);
      }
      return row;
    });
  }

  async upsertConnection(input: Omit<DbConnection, 'token_version' | 'status'>): Promise<string> {
    const now = new Date().toISOString();
    const row = await this.one<{ id: string }>(`INSERT INTO buffer_connections
      (id,tenant_id,buffer_account_id,access_token_ciphertext,refresh_token_ciphertext,access_expires_at,scopes,status,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'active',$8,$8)
      ON CONFLICT(tenant_id,buffer_account_id) DO UPDATE SET access_token_ciphertext=EXCLUDED.access_token_ciphertext,
      refresh_token_ciphertext=EXCLUDED.refresh_token_ciphertext,access_expires_at=EXCLUDED.access_expires_at,scopes=EXCLUDED.scopes,
      status='active',token_version=buffer_connections.token_version+1,updated_at=EXCLUDED.updated_at RETURNING id`,
      [input.id, input.tenant_id, input.buffer_account_id, input.access_token_ciphertext, input.refresh_token_ciphertext,
        input.access_expires_at, input.scopes, now]);
    if (!row) throw new Error('Buffer connection could not be stored');
    return row.id;
  }

  async getConnection(tenantId: string, connectionId?: string): Promise<DbConnection | undefined> {
    return this.one<DbConnection>(connectionId ? 'SELECT * FROM buffer_connections WHERE tenant_id=$1 AND id=$2'
      : 'SELECT * FROM buffer_connections WHERE tenant_id=$1 ORDER BY created_at LIMIT 1', connectionId ? [tenantId, connectionId] : [tenantId]);
  }

  async requireAuthenticatedTenantConnection(tenantId: string, now = new Date()): Promise<DbConnection> {
    if (!tenantId.trim()) throw new Error('An explicit authenticated tenant is required');
    if (!await this.one('SELECT 1 present FROM browser_sessions WHERE tenant_id=$1 AND expires_at>$2 LIMIT 1', [tenantId, now.toISOString()])) {
      throw new Error('The selected tenant has no unexpired browser session');
    }
    const rows = (await this.pool.query<DbConnection>(`SELECT * FROM buffer_connections WHERE tenant_id=$1 AND status='active' ORDER BY created_at`, [tenantId])).rows;
    if (rows.length !== 1) throw new Error(`Read-only verification requires exactly one active connection for the authenticated tenant; found ${rows.length}`);
    return rows[0];
  }

  async rotateTokens(connectionId: string, expectedVersion: number, access: string, refresh: string, expiresAt: string, scopes: string): Promise<boolean> {
    return (await this.pool.query(`UPDATE buffer_connections SET access_token_ciphertext=$1,refresh_token_ciphertext=$2,access_expires_at=$3,
      scopes=$4,token_version=token_version+1,status='active',updated_at=$5 WHERE id=$6 AND token_version=$7`,
      [access, refresh, expiresAt, scopes, new Date().toISOString(), connectionId, expectedVersion])).rowCount === 1;
  }

  async reauthorizeConnection(input: { tenantId: string; connectionId: string; expectedAccountId: string; expectedVersion: number;
    access: string; refresh: string; expiresAt: string; scopes: string; now?: Date }): Promise<boolean> {
    return (await this.pool.query(`UPDATE buffer_connections SET access_token_ciphertext=$1,refresh_token_ciphertext=$2,
      access_expires_at=$3,scopes=$4,token_version=token_version+1,status='active',updated_at=$5
      WHERE tenant_id=$6 AND id=$7 AND buffer_account_id=$8 AND token_version=$9 AND status='reauthorization_required'`,
      [input.access, input.refresh, input.expiresAt, input.scopes, (input.now ?? new Date()).toISOString(), input.tenantId,
        input.connectionId, input.expectedAccountId, input.expectedVersion])).rowCount === 1;
  }

  async acquireTokenRefreshClaim(connectionId: string, tokenVersion: number, ownerId: string, now: Date, expiresAt: Date):
    Promise<'acquired' | 'newer_tokens' | 'in_progress' | 'uncertain' | 'expired_uncertain'> {
    return this.tx(async (client) => {
      const connection = (await client.query<{ token_version: number; status: string }>(
        'SELECT token_version,status FROM buffer_connections WHERE id=$1 FOR UPDATE', [connectionId])).rows[0];
      if (!connection || connection.status !== 'active') return 'uncertain';
      if (connection.token_version !== tokenVersion) return 'newer_tokens';
      const claim = (await client.query<{ token_version: number; state: string; expires_at: string }>(
        'SELECT token_version,state,expires_at FROM token_refresh_claims WHERE connection_id=$1 FOR UPDATE', [connectionId])).rows[0];
      if (claim?.token_version === tokenVersion) {
        if (claim.state === 'claimed' && claim.expires_at <= now.toISOString()) {
          await client.query(`UPDATE token_refresh_claims SET owner_id=$1,state='claimed',claimed_at=$2,expires_at=$3,
            request_started_at=NULL,completed_at=NULL WHERE connection_id=$4`, [ownerId, now.toISOString(), expiresAt.toISOString(), connectionId]);
          return 'acquired';
        }
        if (claim.state === 'claimed') return 'in_progress';
        return claim.expires_at <= now.toISOString() && claim.state !== 'completed' ? 'expired_uncertain' : 'uncertain';
      }
      if (claim && claim.token_version > tokenVersion) return 'newer_tokens';
      await client.query(`INSERT INTO token_refresh_claims(connection_id,token_version,owner_id,state,claimed_at,expires_at)
        VALUES($1,$2,$3,'claimed',$4,$5) ON CONFLICT(connection_id) DO UPDATE SET token_version=EXCLUDED.token_version,
        owner_id=EXCLUDED.owner_id,state='claimed',claimed_at=EXCLUDED.claimed_at,expires_at=EXCLUDED.expires_at,
        request_started_at=NULL,completed_at=NULL`, [connectionId, tokenVersion, ownerId, now.toISOString(), expiresAt.toISOString()]);
      return 'acquired';
    });
  }

  async startTokenRefresh(connectionId: string, tokenVersion: number, ownerId: string, now: Date, expiresAt: Date): Promise<boolean> {
    return (await this.pool.query(`UPDATE token_refresh_claims SET state='request_started',request_started_at=$1,expires_at=$2
      WHERE connection_id=$3 AND token_version=$4 AND owner_id=$5 AND state='claimed' AND expires_at>$1`,
      [now.toISOString(), expiresAt.toISOString(), connectionId, tokenVersion, ownerId])).rowCount === 1;
  }

  async commitTokenRefresh(input: { connectionId: string; expectedVersion: number; ownerId: string; access: string; refresh: string;
    expiresAt: string; scopes: string; now?: Date }): Promise<boolean> {
    return this.tx(async (client) => {
      const claim = await client.query(`SELECT 1 FROM token_refresh_claims WHERE connection_id=$1 AND token_version=$2
        AND owner_id=$3 AND state='request_started' FOR UPDATE`, [input.connectionId, input.expectedVersion, input.ownerId]);
      if (!claim.rowCount) return false;
      const updated = await client.query(`UPDATE buffer_connections SET access_token_ciphertext=$1,refresh_token_ciphertext=$2,
        access_expires_at=$3,scopes=$4,token_version=token_version+1,status='active',updated_at=$5 WHERE id=$6 AND token_version=$7`,
        [input.access, input.refresh, input.expiresAt, input.scopes, (input.now ?? new Date()).toISOString(), input.connectionId, input.expectedVersion]);
      if (updated.rowCount !== 1) return false;
      await client.query(`UPDATE token_refresh_claims SET state='completed',completed_at=$1 WHERE connection_id=$2 AND token_version=$3 AND owner_id=$4`,
        [(input.now ?? new Date()).toISOString(), input.connectionId, input.expectedVersion, input.ownerId]);
      return true;
    });
  }

  async markTokenRefreshAmbiguous(connectionId: string, tokenVersion: number, ownerId: string, now = new Date()): Promise<void> {
    await this.tx(async (client) => {
      await client.query(`UPDATE token_refresh_claims SET state='ambiguous',completed_at=$1 WHERE connection_id=$2 AND token_version=$3
        AND owner_id=$4 AND state='request_started'`, [now.toISOString(), connectionId, tokenVersion, ownerId]);
      await client.query(`UPDATE buffer_connections SET status='reauthorization_required',updated_at=$1 WHERE id=$2 AND token_version=$3`,
        [now.toISOString(), connectionId, tokenVersion]);
    });
  }

  async claimEditIntent(tenantId: string, intentId: string, postId: string, claimId: string, now = new Date()): Promise<Record<string, string> | undefined> {
    return this.tx(async (client) => {
      const intent = (await client.query<Record<string, string>>(`SELECT * FROM edit_intents WHERE id=$1 AND tenant_id=$2 AND post_id=$3
        AND status='pending' AND expires_at>$4 FOR UPDATE`, [intentId, tenantId, postId, now.toISOString()])).rows[0];
      if (!intent) return undefined;
      const inserted = await client.query(`INSERT INTO edit_intent_claims(intent_id,tenant_id,claim_id,state,claimed_at,expires_at)
        VALUES($1,$2,$3,'claimed',$4,$5) ON CONFLICT(intent_id) DO NOTHING`, [intentId, tenantId, claimId, now.toISOString(), intent.expires_at]);
      if (inserted.rowCount === 1) return intent;
      const expired = await client.query(`UPDATE edit_intent_claims SET state='failed',completed_at=$1 WHERE intent_id=$2 AND tenant_id=$3
        AND state='claimed' AND expires_at<=$1`, [now.toISOString(), intentId, tenantId]);
      if (expired.rowCount === 1) await client.query(`UPDATE edit_intents SET status='aborted_stale',outcome_json=$1 WHERE id=$2 AND tenant_id=$3 AND status='pending'`,
        [JSON.stringify({ reason: 'Approval claim expired before mutation; a new intent is required' }), intentId, tenantId]);
      const uncertain = await client.query(`UPDATE edit_intent_claims SET state='ambiguous',completed_at=$1 WHERE intent_id=$2 AND tenant_id=$3
        AND state='mutation_started' AND expires_at<=$1`, [now.toISOString(), intentId, tenantId]);
      if (uncertain.rowCount === 1) await client.query(`UPDATE edit_intents SET status='ambiguous',outcome_json=$1 WHERE id=$2 AND tenant_id=$3 AND status='pending'`,
        [JSON.stringify({ reason: 'The mutation-start claim expired; Buffer outcome requires manual verification and must not be replayed' }), intentId, tenantId]);
      return undefined;
    });
  }

  async startEditMutation(intentId: string, claimId: string, now = new Date()): Promise<boolean> {
    return (await this.pool.query(`UPDATE edit_intent_claims SET state='mutation_started',mutation_started_at=$1
      WHERE intent_id=$2 AND claim_id=$3 AND state='claimed' AND expires_at>$1`, [now.toISOString(), intentId, claimId])).rowCount === 1;
  }

  async finishEditClaim(intentId: string, claimId: string, state: 'completed' | 'ambiguous' | 'failed', now = new Date()): Promise<boolean> {
    return (await this.pool.query(`UPDATE edit_intent_claims SET state=$1,completed_at=$2 WHERE intent_id=$3 AND claim_id=$4
      AND state IN ('claimed','mutation_started')`, [state, now.toISOString(), intentId, claimId])).rowCount === 1;
  }

  async requireReauth(connectionId: string): Promise<void> {
    await this.pool.query(`UPDATE buffer_connections SET status='reauthorization_required',updated_at=$1 WHERE id=$2`, [new Date().toISOString(), connectionId]);
  }

  async requireReauthIfVersion(connectionId: string, expectedVersion: number): Promise<boolean> {
    return (await this.pool.query(`UPDATE buffer_connections SET status='reauthorization_required',updated_at=$1 WHERE id=$2 AND token_version=$3`,
      [new Date().toISOString(), connectionId, expectedVersion])).rowCount === 1;
  }

  async disconnectConnection(tenantId: string, connectionId: string): Promise<boolean> {
    return (await this.pool.query('DELETE FROM buffer_connections WHERE tenant_id=$1 AND id=$2', [tenantId, connectionId])).rowCount === 1;
  }

  async deleteTenant(tenantId: string): Promise<boolean> {
    return (await this.pool.query('DELETE FROM tenants WHERE id=$1', [tenantId])).rowCount === 1;
  }

  async purgeExpiredData(now = new Date()): Promise<void> {
    const iso = now.toISOString();
    const cacheCutoff = new Date(now.getTime() - 86_400_000).toISOString();
    const evidenceCutoff = new Date(now.getTime() - 30 * 86_400_000).toISOString();
    await this.tx(async (client) => {
      await client.query('DELETE FROM edit_intents WHERE expires_at<=$1', [iso]);
      await client.query('DELETE FROM browser_sessions WHERE expires_at<=$1', [iso]);
      await client.query('DELETE FROM posts WHERE synced_at<$1', [cacheCutoff]);
      await client.query('DELETE FROM channels WHERE synced_at<$1', [cacheCutoff]);
      await client.query('DELETE FROM organizations WHERE synced_at<$1', [cacheCutoff]);
      await client.query('DELETE FROM post_media_checks WHERE checked_at<$1', [cacheCutoff]);
      await client.query('DELETE FROM evidence_events WHERE created_at<$1', [evidenceCutoff]);
      await client.query('DELETE FROM tenants t WHERE NOT EXISTS(SELECT 1 FROM browser_sessions s WHERE s.tenant_id=t.id)');
    });
  }

  async replaceDiscovery(tenantId: string, connectionId: string, organizations: Array<{ id: string; name: string; channels: Array<Record<string, unknown>> }>): Promise<void> {
    await this.tx(async (client) => {
      const now = new Date().toISOString();
      await client.query('DELETE FROM channels WHERE tenant_id=$1 AND connection_id=$2', [tenantId, connectionId]);
      await client.query('DELETE FROM organizations WHERE tenant_id=$1 AND connection_id=$2', [tenantId, connectionId]);
      for (const org of organizations) {
        await client.query('INSERT INTO organizations(id,tenant_id,connection_id,name,synced_at) VALUES($1,$2,$3,$4,$5)', [org.id, tenantId, connectionId, org.name, now]);
        for (const channel of org.channels) await client.query(`INSERT INTO channels
          (id,tenant_id,connection_id,organization_id,name,display_name,service,is_disconnected,is_locked,synced_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [String(channel.id), tenantId, connectionId, org.id, String(channel.name),
          channel.displayName == null ? null : String(channel.displayName), String(channel.service), channel.isDisconnected ? 1 : 0, channel.isLocked ? 1 : 0, now]);
      }
    });
  }

  async replacePosts(tenantId: string, connectionId: string, organizationId: string, posts: BufferPost[]): Promise<void> {
    await this.tx(async (client) => {
      const now = new Date().toISOString();
      await client.query('DELETE FROM posts WHERE tenant_id=$1 AND connection_id=$2 AND organization_id=$3', [tenantId, connectionId, organizationId]);
      for (const post of posts) await client.query(`INSERT INTO posts
        (id,tenant_id,connection_id,organization_id,channel_id,status,due_at,share_mode,scheduling_type,text_content,updated_at_remote,sanitized_json,synced_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'',$10,$11,$12)
        ON CONFLICT(tenant_id,id) DO UPDATE SET channel_id=EXCLUDED.channel_id,status=EXCLUDED.status,due_at=EXCLUDED.due_at,
        share_mode=EXCLUDED.share_mode,scheduling_type=EXCLUDED.scheduling_type,text_content='',updated_at_remote=EXCLUDED.updated_at_remote,
        sanitized_json=EXCLUDED.sanitized_json,synced_at=EXCLUDED.synced_at`, [post.id, tenantId, connectionId, organizationId,
        post.channelId, post.status, post.dueAt, post.shareMode, post.schedulingType, post.updatedAt, JSON.stringify({ assetCount: post.assets.length }), now]);
    });
  }

  async removePostsOutsideOrganizations(tenantId: string, connectionId: string, organizationIds: string[]): Promise<void> {
    if (!organizationIds.length) { await this.pool.query('DELETE FROM posts WHERE tenant_id=$1 AND connection_id=$2', [tenantId, connectionId]); return; }
    await this.pool.query('DELETE FROM posts WHERE tenant_id=$1 AND connection_id=$2 AND NOT(organization_id=ANY($3::text[]))',
      [tenantId, connectionId, organizationIds]);
  }

  async listDashboard(tenantId: string): Promise<{ channels: unknown[]; posts: unknown[] }> {
    const [channels, posts] = await Promise.all([
      this.pool.query('SELECT id,name,display_name,service,is_disconnected,is_locked FROM channels WHERE tenant_id=$1 ORDER BY service,name', [tenantId]),
      this.pool.query(`SELECT p.id,p.channel_id,p.status,p.due_at,p.synced_at,COALESCE((p.sanitized_json::jsonb->>'assetCount')::integer,0) asset_count,
        c.display_name channel_display_name,c.name channel_name,c.service channel_service,m.status media_status,m.checked_count,m.summary_json,m.checked_at
        FROM posts p LEFT JOIN channels c ON c.tenant_id=p.tenant_id AND c.id=p.channel_id
        LEFT JOIN post_media_checks m ON m.tenant_id=p.tenant_id AND m.post_id=p.id WHERE p.tenant_id=$1 ORDER BY p.due_at`, [tenantId]),
    ]);
    return { channels: channels.rows, posts: posts.rows };
  }

  async getDashboardPost(tenantId: string, connectionId: string, postId: string): Promise<Record<string, unknown> | undefined> {
    return this.one(`SELECT p.id,p.channel_id,p.status,p.due_at,p.synced_at,COALESCE((p.sanitized_json::jsonb->>'assetCount')::integer,0) asset_count,
      c.display_name channel_display_name,c.name channel_name,c.service channel_service,m.status media_status,m.checked_count,m.summary_json,m.checked_at
      FROM posts p LEFT JOIN channels c ON c.tenant_id=p.tenant_id AND c.id=p.channel_id
      LEFT JOIN post_media_checks m ON m.tenant_id=p.tenant_id AND m.post_id=p.id
      WHERE p.tenant_id=$1 AND p.connection_id=$2 AND p.id=$3`, [tenantId, connectionId, postId]);
  }

  async saveMediaCheck(input: { tenantId: string; connectionId: string; postId: string; status: 'ready' | 'confirmed_problem' | 'could_not_verify' | 'unsupported_file'; checkedCount: number; summary: unknown; requestId?: string; checkedAt?: string }): Promise<void> {
    await this.pool.query(`INSERT INTO post_media_checks(tenant_id,connection_id,post_id,status,checked_count,summary_json,request_id,checked_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(tenant_id,post_id) DO UPDATE SET connection_id=EXCLUDED.connection_id,
      status=EXCLUDED.status,checked_count=EXCLUDED.checked_count,summary_json=EXCLUDED.summary_json,request_id=EXCLUDED.request_id,checked_at=EXCLUDED.checked_at`,
      [input.tenantId, input.connectionId, input.postId, input.status, input.checkedCount, JSON.stringify(input.summary), input.requestId ?? null,
        input.checkedAt ?? new Date().toISOString()]);
  }

  async getFreshConfirmedProblemEvidence(tenantId: string, connectionId: string, postId: string, now = new Date()): Promise<{
    checkedAt: string; summary: Array<{ position: number; label: string; detail?: string; httpStatus?: number }> } | undefined> {
    const row = await this.one<{ summary_json: string; checked_at: string }>(`SELECT summary_json,checked_at FROM post_media_checks
      WHERE tenant_id=$1 AND connection_id=$2 AND post_id=$3 AND status='confirmed_problem' AND checked_at>$4`,
      [tenantId, connectionId, postId, new Date(now.getTime() - 600_000).toISOString()]);
    if (!row) return undefined;
    const summary = (JSON.parse(row.summary_json) as Array<{ position?: unknown; label?: unknown; detail?: unknown; httpStatus?: unknown }>)
      .filter((item) => item.label === 'CONFIRMED PROBLEM' && Number.isInteger(item.position))
      .map((item) => ({ position: Number(item.position), label: 'CONFIRMED PROBLEM',
        detail: typeof item.detail === 'string' ? item.detail : undefined,
        httpStatus: typeof item.httpStatus === 'number' ? item.httpStatus : undefined }));
    return summary.length ? { checkedAt: row.checked_at, summary } : undefined;
  }

  async getFreshConfirmedProblemPositions(tenantId: string, connectionId: string, postId: string, now = new Date()): Promise<number[]> {
    return (await this.getFreshConfirmedProblemEvidence(tenantId, connectionId, postId, now))?.summary.map((item) => item.position) ?? [];
  }

  async hasFreshConfirmedProblem(tenantId: string, connectionId: string, postId: string, now = new Date()): Promise<boolean> {
    return (await this.getFreshConfirmedProblemPositions(tenantId, connectionId, postId, now)).length > 0;
  }

  async hasCachedPost(tenantId: string, connectionId: string, postId: string): Promise<boolean> {
    return Boolean(await this.one('SELECT 1 present FROM posts WHERE tenant_id=$1 AND connection_id=$2 AND id=$3', [tenantId, connectionId, postId]));
  }

  async addEvidence(input: { id: string; tenantId: string; operation: string; outcome: string; requestId?: string; sanitized: unknown }): Promise<void> {
    await this.pool.query(`INSERT INTO evidence_events(id,tenant_id,operation,outcome,request_id,sanitized_json,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [input.id, input.tenantId, input.operation, input.outcome, input.requestId ?? null, JSON.stringify(input.sanitized), new Date().toISOString()]);
  }

  async getPostOrganizationId(tenantId: string, connectionId: string, postId: string, channelId?: string): Promise<string | undefined> {
    return (await this.one<{ organization_id: string }>(`SELECT organization_id FROM posts WHERE tenant_id=$1 AND connection_id=$2 AND id=$3${channelId ? ' AND channel_id=$4' : ''}`,
      channelId ? [tenantId, connectionId, postId, channelId] : [tenantId, connectionId, postId]))?.organization_id;
  }

  async createEditIntent(input: { id: string; tenantId: string; connectionId: string; postId: string; beforeJson: string;
    intendedAssetsJson: string; beforeFingerprint: string; createdAt: string; expiresAt: string; outcomeJson: string }): Promise<void> {
    await this.pool.query(`INSERT INTO edit_intents(id,tenant_id,connection_id,post_id,before_json,intended_assets_json,before_fingerprint,status,created_at,expires_at,outcome_json)
      VALUES($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10)`, [input.id, input.tenantId, input.connectionId, input.postId,
      input.beforeJson, input.intendedAssetsJson, input.beforeFingerprint, input.createdAt, input.expiresAt, input.outcomeJson]);
  }

  async getPendingEditIntent(tenantId: string, intentId: string, now = new Date()): Promise<Record<string, string> | undefined> {
    return this.one(`SELECT * FROM edit_intents WHERE id=$1 AND tenant_id=$2 AND status='pending' AND expires_at>$3`, [intentId, tenantId, now.toISOString()]);
  }

  async getEditIntent(tenantId: string, intentId: string): Promise<Record<string, string> | undefined> {
    return this.one('SELECT * FROM edit_intents WHERE id=$1 AND tenant_id=$2', [intentId, tenantId]);
  }

  async updateEditIntent(intentId: string, status: EditStatus, outcome: unknown, onlyPending = false): Promise<boolean> {
    return (await this.pool.query(`UPDATE edit_intents SET status=$1,outcome_json=$2 WHERE id=$3${onlyPending ? " AND status='pending'" : ''}`,
      [status, JSON.stringify(outcome), intentId])).rowCount === 1;
  }

  async listEvidence(tenantId: string): Promise<Array<Record<string, unknown>>> {
    return (await this.pool.query(`SELECT operation,outcome,request_id,sanitized_json,created_at FROM evidence_events WHERE tenant_id=$1 ORDER BY created_at DESC`,
      [tenantId])).rows;
  }
}
