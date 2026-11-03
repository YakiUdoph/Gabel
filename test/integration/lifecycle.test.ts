import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../src/db.ts';
import type { BufferPost } from '../../src/types.ts';

const post = (id = 'post'): BufferPost => ({
  id, channelId: 'channel', status: 'scheduled', dueAt: '2026-12-01T12:00:00.000Z', shareMode: 'customScheduled',
  schedulingType: 'automatic', text: 'not cached', updatedAt: '2026-11-02T12:00:00.000Z', allowedActions: ['updatePost'],
  metadata: { type: 'post' }, tags: [], assets: [],
});

function isolatedStore(): { store: Store; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), 'gabel-lifecycle-'));
  return { store: new Store(join(directory, 'gabel.db')), directory };
}

function seed(store: Store, tenantId: string, connectionId: string, suffix = ''): void {
  store.createTenant(tenantId);
  store.createSession({ idHash: `session${suffix}`, tenantId, csrfHash: `csrf${suffix}`, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  store.upsertConnection({ id: connectionId, tenant_id: tenantId, buffer_account_id: `account${suffix}`,
    access_token_ciphertext: `encrypted-access${suffix}`, refresh_token_ciphertext: `encrypted-refresh${suffix}`,
    access_expires_at: new Date(Date.now() + 60_000).toISOString(), scopes: 'offline_access' });
  store.replaceDiscovery(tenantId, connectionId, [{ id: `org${suffix}`, name: 'Org', channels: [{ id: `channel${suffix}`, name: 'Channel', service: 'test', isDisconnected: false, isLocked: false }] }]);
  const value = post(`post${suffix}`);
  value.channelId = `channel${suffix}`;
  store.replacePosts(tenantId, connectionId, `org${suffix}`, [value]);
  store.db.prepare(`INSERT INTO edit_intents(id,tenant_id,connection_id,post_id,before_json,intended_assets_json,before_fingerprint,status,created_at,expires_at)
    VALUES(?,?,?,?,?,?,?,'pending',?,?)`).run(`intent${suffix}`, tenantId, connectionId, value.id, '{}', '[]', 'fingerprint',
      new Date().toISOString(), new Date(Date.now() + 60_000).toISOString());
  store.addEvidence({ id: `evidence${suffix}`, tenantId, operation: 'test', outcome: 'success', sanitized: {} });
}

function count(store: Store, table: string, tenantId: string): number {
  return (store.db.prepare(`SELECT COUNT(*) count FROM ${table} WHERE tenant_id=?`).get(tenantId) as { count: number }).count;
}

test('isolated disconnect denies cross-account deletion and cascades only connection-owned data', () => {
  const { store, directory } = isolatedStore();
  const owner = randomUUID();
  const other = randomUUID();
  try {
    seed(store, owner, 'owner-connection', '-owner');
    seed(store, other, 'other-connection', '-other');
    assert.equal(store.disconnectConnection(other, 'owner-connection'), false);
    assert.ok(store.getConnection(owner, 'owner-connection'));
    assert.equal(store.disconnectConnection(owner, 'owner-connection'), true);
    for (const table of ['buffer_connections', 'organizations', 'channels', 'posts', 'edit_intents']) assert.equal(count(store, table, owner), 0, table);
    assert.equal(count(store, 'browser_sessions', owner), 1);
    assert.equal(count(store, 'evidence_events', owner), 1);
    assert.equal(count(store, 'buffer_connections', other), 1);
    assert.equal(count(store, 'posts', other), 1);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('isolated account deletion cascades every tenant record without affecting another tenant', () => {
  const { store, directory } = isolatedStore();
  const deleted = randomUUID();
  const retained = randomUUID();
  try {
    seed(store, deleted, 'deleted-connection', '-deleted');
    seed(store, retained, 'retained-connection', '-retained');
    assert.equal(store.deleteTenant(deleted), true);
    for (const table of ['tenants', 'browser_sessions', 'buffer_connections', 'organizations', 'channels', 'posts', 'edit_intents', 'evidence_events']) {
      const column = table === 'tenants' ? 'id' : 'tenant_id';
      const remaining = (store.db.prepare(`SELECT COUNT(*) count FROM ${table} WHERE ${column}=?`).get(deleted) as { count: number }).count;
      assert.equal(remaining, 0, table);
    }
    assert.equal(count(store, 'buffer_connections', retained), 1);
    assert.equal(count(store, 'evidence_events', retained), 1);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('isolated retention purge removes expired sessions/intents, stale cache, and old evidence only', () => {
  const { store, directory } = isolatedStore();
  const tenant = randomUUID();
  const now = new Date('2026-11-02T12:00:00.000Z');
  try {
    seed(store, tenant, 'connection', '-retention');
    store.createSession({ idHash: 'fresh-session', tenantId: tenant, csrfHash: 'fresh-csrf', expiresAt: new Date(now.getTime() + 60_000).toISOString() });
    store.db.prepare('UPDATE browser_sessions SET expires_at=? WHERE id_hash=?').run(new Date(now.getTime() - 1).toISOString(), 'session-retention');
    store.db.prepare('UPDATE edit_intents SET expires_at=? WHERE id=?').run(new Date(now.getTime() - 1).toISOString(), 'intent-retention');
    store.db.prepare('UPDATE posts SET synced_at=? WHERE tenant_id=?').run(new Date(now.getTime() - 24 * 60 * 60_000 - 1).toISOString(), tenant);
    store.db.prepare('UPDATE channels SET synced_at=? WHERE tenant_id=?').run(new Date(now.getTime() - 24 * 60 * 60_000 - 1).toISOString(), tenant);
    store.db.prepare('UPDATE organizations SET synced_at=? WHERE tenant_id=?').run(new Date(now.getTime() - 24 * 60 * 60_000 - 1).toISOString(), tenant);
    store.db.prepare('UPDATE evidence_events SET created_at=? WHERE id=?').run(new Date(now.getTime() - 30 * 24 * 60 * 60_000 - 1).toISOString(), 'evidence-retention');
    store.addEvidence({ id: 'fresh-evidence', tenantId: tenant, operation: 'test', outcome: 'success', sanitized: {} });
    store.purgeExpiredData(now);
    assert.equal(count(store, 'browser_sessions', tenant), 1);
    assert.equal(count(store, 'edit_intents', tenant), 0);
    for (const table of ['posts', 'channels', 'organizations']) assert.equal(count(store, table, tenant), 0, table);
    assert.equal(count(store, 'evidence_events', tenant), 1);
    assert.equal(count(store, 'buffer_connections', tenant), 1);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
