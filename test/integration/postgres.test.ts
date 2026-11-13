import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { PostgresStore } from '../../src/postgres-db.ts';
import { beginOAuth, consumeOAuth } from '../../src/oauth.ts';
import type { Config } from '../../src/config.ts';

const databaseUrl = process.env.DATABASE_URL;

test('Neon persists sessions and credentials across instances while fencing OAuth and edit claims',
  { skip: databaseUrl ? false : 'DATABASE_URL is not configured for the PostgreSQL integration test' }, async () => {
    const tenantId = `integration-${randomUUID()}`;
    const connectionId = randomUUID();
    const sessionHash = randomUUID();
    const now = Date.now();
    const config = {
      bufferClientId: 'postgres-integration-client',
      bufferRedirectUri: 'https://gabel-six.vercel.app/auth/buffer/callback',
      encryptionKey: randomBytes(32),
    } as Config;
    const first = new PostgresStore(databaseUrl!);
    await first.migrate();
    try {
      await first.createTenant(tenantId);
      await first.createSession({ idHash: sessionHash, tenantId, csrfHash: randomUUID(), expiresAt: new Date(now + 60_000).toISOString() });
      await first.upsertConnection({ id: connectionId, tenant_id: tenantId, buffer_account_id: randomUUID(),
        access_token_ciphertext: 'encrypted-integration-fixture', refresh_token_ciphertext: null,
        access_expires_at: new Date(now + 60_000).toISOString(), scopes: 'fixture' });
      await first.createEditIntent({ id: randomUUID(), tenantId, connectionId, postId: 'fixture-post', beforeJson: '{}',
        intendedAssetsJson: '[]', beforeFingerprint: 'fixture', createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(), outcomeJson: '{}' });
    } finally { await first.close(); }

    const second = new PostgresStore(databaseUrl!);
    const third = new PostgresStore(databaseUrl!);
    try {
      assert.equal((await second.getSession(sessionHash))?.tenant_id, tenantId);
      assert.equal((await second.getConnection(tenantId, connectionId))?.id, connectionId);

      const oauth = await beginOAuth(second, config, sessionHash);
      const consumed = await consumeOAuth(third, config, sessionHash, oauth.state);
      assert.equal(consumed?.verifier, oauth.verifier);
      assert.equal(await consumeOAuth(second, config, sessionHash, oauth.state), undefined);

      const editId = randomUUID();
      await second.createEditIntent({ id: editId, tenantId, connectionId, postId: 'fixture-post-2', beforeJson: '{}',
        intendedAssetsJson: '[]', beforeFingerprint: 'fixture', createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 60_000).toISOString(), outcomeJson: '{}' });
      const claims = await Promise.all([
        second.claimEditIntent(tenantId, editId, 'fixture-post-2', randomUUID()),
        third.claimEditIntent(tenantId, editId, 'fixture-post-2', randomUUID()),
      ]);
      assert.equal(claims.filter(Boolean).length, 1);

      assert.equal(await second.deleteTenant(tenantId), true);
      assert.equal(await third.getSession(sessionHash), undefined);
      assert.equal(await third.getConnection(tenantId, connectionId), undefined);
    } finally {
      await Promise.all([second.close(), third.close()]);
    }
  });
