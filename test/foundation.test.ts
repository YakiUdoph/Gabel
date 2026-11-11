import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { beginOAuth, consumeOAuth } from '../src/oauth.ts';
import { BufferAuthorizationError, bufferAuthorizationFailureEvidence, saveAuthorizedBufferConnection } from '../src/buffer-authorization.ts';
import { BufferClient, BufferError, graphqlOperationName, POST_LIST_QUERY, safeBufferErrorDiagnostic, tokenRequest } from '../src/buffer.ts';
import { assertPostEditable, buildCompleteAssetList, classifyMutationException, comparePost, EditService, fingerprintPost } from '../src/edit.ts';
import { decrypt, encrypt, pkceChallenge, sanitize, sha256 } from '../src/security.ts';
import { SESSION_COOKIE_MAX_AGE_SECONDS, serializeCookie } from '../src/cookies.ts';
import type { BufferPost } from '../src/types.ts';
import { classifyMediaContentType, detectImageDimensions, detectImageSignature, isProhibitedNetworkAddress, mediaFormatFromContentType, probeMediaUrl, publicMediaStatus, returnPinnedLookup, validateMediaRedirect, validatePublicMediaUrl, type MediaProbeResult } from '../src/media-security.ts';
import { assertFreshMatchingValidation, validateImageReplacements, type ReplacementValidationEvidence } from '../src/replacement-validation.ts';
import { renderPage } from '../src/views.ts';
import { privacyNotice, termsOfService } from '../src/legal.ts';

const config = (): Config => ({
  appOrigin: 'https://localhost:3443', port: 3443, bufferClientId: 'client-id', bufferClientSecret: 'client-secret',
  bufferRedirectUri: 'https://localhost:3443/auth/buffer/callback', encryptionKey: randomBytes(32), cookieSecret: randomBytes(32),
  databasePath: ':memory:', requestTimeoutMs: 1000,
  operatorName: 'Example Operator', supportEmail: 'support@example.test', privacyEmail: 'privacy@example.test',
});

const productionEnvironment = (): NodeJS.ProcessEnv => ({
  NODE_ENV: 'production', APP_ORIGIN: 'https://gabel.example.org', PORT: '3443',
  BUFFER_CLIENT_ID: 'buffer-client', BUFFER_REDIRECT_URI: 'https://gabel.example.org/auth/buffer/callback',
  APP_ENCRYPTION_KEY: randomBytes(32).toString('base64url'), APP_COOKIE_SECRET: randomBytes(32).toString('base64url'),
  DATABASE_PATH: './data/production-test.db', TLS_KEY_PATH: './private/key.pem', TLS_CERT_PATH: './private/cert.pem',
  BUFFER_REQUEST_TIMEOUT_MS: '15000', OPERATOR_NAME: 'Verified Operator',
  SUPPORT_EMAIL: 'support@gabel.example.org', PRIVACY_EMAIL: 'privacy@gabel.example.org',
});

function setup() {
  const store = new Store(':memory:');
  const tenant = randomUUID();
  const session = sha256('session');
  store.createTenant(tenant);
  store.createSession({ idHash: session, tenantId: tenant, csrfHash: sha256('csrf'), expiresAt: new Date(Date.now() + 60_000).toISOString() });
  return { store, tenant, session };
}

function response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

const post = (overrides: Partial<BufferPost> = {}): BufferPost => ({
  id: 'post-1', channelId: 'channel-1', status: 'scheduled', dueAt: '2026-11-01T12:00:00.000Z',
  shareMode: 'customScheduled', schedulingType: 'automatic', text: 'Private content', updatedAt: '2026-10-23T12:00:00.000Z',
  allowedActions: ['updatePost'], metadata: { type: 'post' }, tags: [{ id: 'tag-1', name: 'Private tag' }],
  assets: [
    { id: 'a', type: 'image', mimeType: 'image/jpeg', source: 'https://media.example/a.jpg', thumbnail: 'https://media.example/a-thumb.jpg', image: { altText: 'A', animatedThumbnail: null, userTags: [{ handle: 'person', x: 0.5, y: 0.4 }] } },
    { id: 'b', type: 'video', mimeType: 'video/mp4', source: 'https://media.example/b.mp4', thumbnail: 'https://media.example/b-thumb.jpg', video: { thumbnailOffset: 1000, title: 'B' } },
  ], ...overrides,
});

test('PKCE uses a URL-safe SHA-256 challenge', () => {
  assert.equal(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('production configuration fails closed on malformed origins, callback drift, placeholders, and unsafe secrets', () => {
  const valid = productionEnvironment();
  const parsed = loadConfig(valid);
  assert.equal(parsed.appOrigin, 'https://gabel.example.org');
  assert.equal(parsed.bufferRedirectUri, 'https://gabel.example.org/auth/buffer/callback');
  assert.equal(parsed.port, 3443);

  for (const override of [
    { APP_ORIGIN: 'http://gabel.example.org' },
    { APP_ORIGIN: 'https://gabel.example.org/path' },
    { APP_ORIGIN: 'https://localhost:3443', BUFFER_REDIRECT_URI: 'https://localhost:3443/auth/buffer/callback' },
    { BUFFER_REDIRECT_URI: 'https://other.example.org/auth/buffer/callback' },
    { BUFFER_REDIRECT_URI: 'https://gabel.example.org/callback' },
    { PORT: '0' }, { PORT: 'not-a-port' }, { BUFFER_REQUEST_TIMEOUT_MS: '999' },
    { NODE_ENV: 'prodution' }, { BUFFER_CLIENT_ID: 'change-me' },
    { OPERATOR_NAME: 'TODO' }, { SUPPORT_EMAIL: 'support@example.invalid' },
  ]) assert.throws(() => loadConfig({ ...valid, ...override }));

  assert.throws(() => loadConfig({ ...valid, APP_COOKIE_SECRET: valid.APP_ENCRYPTION_KEY }), /must be different/);
  assert.throws(() => loadConfig({ ...valid, APP_ENCRYPTION_KEY: 'not+base64/value' }), /base64url/);
  assert.throws(() => loadConfig({ ...valid, DATABASE_PATH: ':memory:' }), /persistent/);
});

test('OAuth state is one-time and rejects mismatches', () => {
  const { store, session } = setup();
  const cfg = config();
  const flow = beginOAuth(store, cfg, session);
  assert.equal(consumeOAuth(store, cfg, session, 'wrong'), undefined);
  assert.equal(consumeOAuth(store, cfg, session, flow.state)?.verifier, flow.verifier);
  assert.equal(consumeOAuth(store, cfg, session, flow.state), undefined);
  store.close();
});

test('OAuth session cookies survive the cross-site top-level callback securely', () => {
  const sessionCookie = serializeCookie('gabel_session=signed', true);
  const csrfCookie = serializeCookie('gabel_csrf=signed', false);
  for (const cookie of [sessionCookie, csrfCookie]) {
    assert.match(cookie, /; Path=\//);
    assert.match(cookie, /; Secure/);
    assert.match(cookie, /; SameSite=Lax/);
    assert.match(cookie, new RegExp(`; Max-Age=${SESSION_COOKIE_MAX_AGE_SECONDS}`));
    assert.doesNotMatch(cookie, /; Domain=/);
    assert.doesNotMatch(cookie, /; SameSite=Strict/);
  }
  assert.match(sessionCookie, /; HttpOnly/);
  assert.doesNotMatch(csrfCookie, /; HttpOnly/);
});

test('active sessions use sliding inactivity expiry', () => {
  const { store, session } = setup();
  const before = String((store.getSession(session) as Record<string, unknown>).expires_at);
  const extended = new Date(Date.now() + SESSION_COOKIE_MAX_AGE_SECONDS * 1000).toISOString();
  assert.equal(store.touchSession(session, extended), true);
  assert.ok(String((store.getSession(session) as Record<string, unknown>).expires_at) > before);
  assert.equal(store.touchSession('missing-session', extended), false);
  store.close();
});

test('OAuth state expires and concurrent starts retain only the latest attempt', () => {
  const { store, session } = setup();
  const cfg = config();
  const first = beginOAuth(store, cfg, session);
  const second = beginOAuth(store, cfg, session);
  assert.equal(consumeOAuth(store, cfg, session, first.state), undefined);
  assert.equal(consumeOAuth(store, cfg, session, second.state)?.verifier, second.verifier);
  assert.equal(consumeOAuth(store, cfg, session, second.state), undefined);

  const expired = beginOAuth(store, cfg, session);
  store.db.prepare('UPDATE browser_sessions SET oauth_expires_at = ? WHERE id_hash = ?')
    .run(new Date(0).toISOString(), session);
  assert.equal(consumeOAuth(store, cfg, session, expired.state), undefined);
  store.close();
});

test('OAuth state and encrypted PKCE verifier survive a server-store restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gabel-oauth-test-'));
  const databasePath = join(directory, 'gabel.db');
  const cfg = config();
  const tenant = randomUUID();
  const session = sha256('persistent-session');
  let store: Store | undefined;
  try {
    store = new Store(databasePath);
    store.createTenant(tenant);
    store.createSession({ idHash: session, tenantId: tenant, csrfHash: sha256('csrf'), expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const flow = beginOAuth(store, cfg, session);
    store.close();
    store = new Store(databasePath);
    assert.equal(consumeOAuth(store, cfg, session, flow.state)?.verifier, flow.verifier);
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

const authorizedTokens = (overrides: Partial<{ access_token: string; refresh_token: string; token_type: 'Bearer'; expires_in: number; scope: string }> = {}) => ({
  access_token: 'new-access', refresh_token: 'new-refresh', token_type: 'Bearer' as const, expires_in: 3600,
  scope: 'account:read posts:read posts:write offline_access', ...overrides,
});

function setupReauthorization() {
  const context = setup();
  const cfg = config();
  context.store.upsertConnection({ id: 'connection', tenant_id: context.tenant, buffer_account_id: 'expected-account',
    access_token_ciphertext: encrypt('preserved-access', cfg.encryptionKey), refresh_token_ciphertext: encrypt('preserved-refresh', cfg.encryptionKey),
    access_expires_at: new Date(0).toISOString(), scopes: 'account:read posts:read posts:write offline_access' });
  context.store.requireReauth('connection');
  return { ...context, cfg };
}

test('reauthorization preserves tenant evidence and replaces credentials only after matching identity', () => {
  const { store, tenant, session, cfg } = setupReauthorization();
  store.addEvidence({ id: 'evidence-before', tenantId: tenant, operation: 'fixture', outcome: 'not_tested', sanitized: { preserved: true } });
  const flow = beginOAuth(store, cfg, session, { connectionId: 'connection', expectedTokenVersion: 1 });
  const oauth = consumeOAuth(store, cfg, session, flow.state)!;
  assert.deepEqual(oauth.reconnect, { connectionId: 'connection', expectedTokenVersion: 1 });
  const saved = saveAuthorizedBufferConnection({ store, config: cfg, tenantId: tenant, oauth, tokens: authorizedTokens(), accountId: 'expected-account' });
  assert.deepEqual(saved, { connectionId: 'connection', reauthorized: true });
  const connection = store.getConnection(tenant, 'connection')!;
  assert.equal(connection.status, 'active');
  assert.equal(connection.token_version, 2);
  assert.equal(decrypt(connection.access_token_ciphertext, cfg.encryptionKey), 'new-access');
  assert.equal(decrypt(connection.refresh_token_ciphertext!, cfg.encryptionKey), 'new-refresh');
  assert.equal((store.db.prepare('SELECT COUNT(*) count FROM evidence_events WHERE tenant_id=?').get(tenant) as { count: number }).count, 1);
  store.close();
});

test('denied or interrupted reauthorization consumes state but preserves existing credentials', () => {
  const { store, tenant, session, cfg } = setupReauthorization();
  const before = store.getConnection(tenant, 'connection')!;
  const denied = beginOAuth(store, cfg, session, { connectionId: 'connection', expectedTokenVersion: before.token_version });
  assert.ok(consumeOAuth(store, cfg, session, denied.state));
  assert.equal(consumeOAuth(store, cfg, session, denied.state), undefined);
  assert.deepEqual(store.getConnection(tenant, 'connection'), before);

  const interrupted = beginOAuth(store, cfg, session, { connectionId: 'connection', expectedTokenVersion: before.token_version });
  assert.ok(consumeOAuth(store, cfg, session, interrupted.state));
  assert.deepEqual(store.getConnection(tenant, 'connection'), before);
  store.close();
});

test('reauthorization rejects insufficient grants and a mismatched Buffer account without changing credentials', () => {
  for (const scenario of ['grant', 'identity'] as const) {
    const { store, tenant, session, cfg } = setupReauthorization();
    const before = store.getConnection(tenant, 'connection')!;
    const flow = beginOAuth(store, cfg, session, { connectionId: 'connection', expectedTokenVersion: 1 });
    const oauth = consumeOAuth(store, cfg, session, flow.state)!;
    assert.throws(() => saveAuthorizedBufferConnection({ store, config: cfg, tenantId: tenant, oauth,
      tokens: scenario === 'grant' ? authorizedTokens({ scope: 'account:read posts:read', refresh_token: '' }) : authorizedTokens(),
      accountId: scenario === 'identity' ? 'different-account' : 'expected-account' }),
    (error: BufferAuthorizationError) => error.code === (scenario === 'grant' ? 'insufficient_permissions' : 'account_mismatch'));
    assert.deepEqual(store.getConnection(tenant, 'connection'), before);
    store.close();
  }
});

test('concurrent reauthorization has one winner and fences a stale refresh credential write', () => {
  const { store, tenant, session, cfg } = setupReauthorization();
  const secondSession = sha256('second-reauthorization-session');
  store.createSession({ idHash: secondSession, tenantId: tenant, csrfHash: sha256('second-csrf'), expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const old = new Date();
  assert.equal(store.acquireTokenRefreshClaim('connection', 1, 'old-refresh-worker', old, new Date(old.getTime() + 60_000)), 'uncertain');
  // Simulate a refresh request that began before Buffer marked the connection for reauthorization.
  store.db.prepare("UPDATE buffer_connections SET status='active' WHERE id='connection'").run();
  assert.equal(store.acquireTokenRefreshClaim('connection', 1, 'old-refresh-worker', old, new Date(old.getTime() + 60_000)), 'acquired');
  assert.equal(store.startTokenRefresh('connection', 1, 'old-refresh-worker', old, new Date(old.getTime() + 60_000)), true);
  store.requireReauth('connection');

  const firstFlow = beginOAuth(store, cfg, session, { connectionId: 'connection', expectedTokenVersion: 1 });
  const secondFlow = beginOAuth(store, cfg, secondSession, { connectionId: 'connection', expectedTokenVersion: 1 });
  const first = consumeOAuth(store, cfg, session, firstFlow.state)!;
  const second = consumeOAuth(store, cfg, secondSession, secondFlow.state)!;
  saveAuthorizedBufferConnection({ store, config: cfg, tenantId: tenant, oauth: first, tokens: authorizedTokens({ access_token: 'winner-access' }), accountId: 'expected-account' });
  assert.throws(() => saveAuthorizedBufferConnection({ store, config: cfg, tenantId: tenant, oauth: second,
    tokens: authorizedTokens({ access_token: 'loser-access' }), accountId: 'expected-account' }),
  (error: BufferAuthorizationError) => error.code === 'stale_reauthorization');
  assert.equal(store.commitTokenRefresh({ connectionId: 'connection', expectedVersion: 1, ownerId: 'old-refresh-worker',
    access: encrypt('stale-access', cfg.encryptionKey), refresh: encrypt('stale-refresh', cfg.encryptionKey),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(), scopes: 'offline_access' }), false);
  const current = store.getConnection(tenant, 'connection')!;
  assert.equal(current.token_version, 2);
  assert.equal(decrypt(current.access_token_ciphertext, cfg.encryptionKey), 'winner-access');
  store.close();
});

test('reauthorization OAuth context is tenant-bound and rejects a cross-tenant connection', () => {
  const { store, session, cfg } = setupReauthorization();
  const otherTenant = randomUUID();
  store.createTenant(otherTenant);
  store.upsertConnection({ id: 'other-connection', tenant_id: otherTenant, buffer_account_id: 'other-account',
    access_token_ciphertext: 'cipher', refresh_token_ciphertext: 'refresh', access_expires_at: new Date(0).toISOString(), scopes: 'offline_access' });
  store.requireReauth('other-connection');
  assert.throws(() => beginOAuth(store, cfg, session, { connectionId: 'other-connection', expectedTokenVersion: 1 }), /no longer eligible/);
  store.close();
});

test('reauthorization evidence retains sanitized transport classification without credentials', () => {
  const error = new BufferError('Buffer API request failed before a response was received', 'network',
    { category: 'permission', errorName: 'Error', code: 'EACCES' }, undefined, undefined, undefined, 'GabelAccountIdentity');
  const evidence = bufferAuthorizationFailureEvidence(error);
  assert.deepEqual(evidence, { reason: 'network', diagnostic: {
    kind: 'network', message: 'Buffer API request failed before a response was received', operationName: 'GabelAccountIdentity',
    httpStatus: undefined, requestId: undefined, retryAfter: undefined,
    details: { category: 'permission', errorName: 'Error', code: 'EACCES' },
  } });
  assert.doesNotMatch(JSON.stringify(evidence), /access_token|refresh_token|authorization/i);
});

test('credentials are encrypted in storage and sanitization redacts secrets', () => {
  const { store, tenant } = setup();
  const cfg = config();
  const ciphertext = encrypt('plain-access-token', cfg.encryptionKey);
  store.upsertConnection({ id: 'connection', tenant_id: tenant, buffer_account_id: 'account', access_token_ciphertext: ciphertext,
    refresh_token_ciphertext: encrypt('plain-refresh-token', cfg.encryptionKey), access_expires_at: new Date(Date.now() + 60_000).toISOString(), scopes: 'offline_access' });
  const raw = store.db.prepare('SELECT access_token_ciphertext FROM buffer_connections').get() as { access_token_ciphertext: string };
  assert.equal(raw.access_token_ciphertext.includes('plain-access-token'), false);
  assert.equal(decrypt(raw.access_token_ciphertext, cfg.encryptionKey), 'plain-access-token');
  const parts = raw.access_token_ciphertext.split('.');
  parts[2] = `${parts[2][0] === 'A' ? 'B' : 'A'}${parts[2].slice(1)}`;
  assert.throws(() => decrypt(parts.join('.'), cfg.encryptionKey));
  assert.deepEqual(sanitize({ access_token: 'secret', nested: { client_secret: 'secret' } }), { access_token: '[REDACTED]', nested: { client_secret: '[REDACTED]' } });
  store.close();
});

test('single-use refresh rotation is serialized for simultaneous callers', async () => {
  const { store, tenant } = setup();
  const cfg = config();
  store.upsertConnection({ id: 'connection', tenant_id: tenant, buffer_account_id: 'account', access_token_ciphertext: encrypt('expired', cfg.encryptionKey),
    refresh_token_ciphertext: encrypt('refresh-1', cfg.encryptionKey), access_expires_at: new Date(0).toISOString(), scopes: 'offline_access' });
  let calls = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    calls++;
    assert.match(String(init?.body), /refresh_token=refresh-1/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return response({ access_token: 'access-2', refresh_token: 'refresh-2', token_type: 'Bearer', expires_in: 3600, scope: 'offline_access' });
  };
  const client = new BufferClient(cfg, store, fetcher);
  const connection = store.getConnection(tenant)!;
  assert.deepEqual(await Promise.all([client.accessToken(connection), client.accessToken(connection), client.accessToken(connection)]), ['access-2', 'access-2', 'access-2']);
  assert.equal(calls, 1);
  assert.equal(decrypt(store.getConnection(tenant)!.refresh_token_ciphertext!, cfg.encryptionKey), 'refresh-2');
  store.close();
});

test('SQLite refresh claims coordinate independent stores and fence stale credential writes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'gabel-refresh-claim-'));
  const databasePath = join(directory, 'gabel.db');
  const cfg = config();
  let first: Store | undefined;
  let second: Store | undefined;
  try {
    first = new Store(databasePath);
    const tenant = randomUUID();
    first.createTenant(tenant);
    first.createSession({ idHash: sha256('refresh-session'), tenantId: tenant, csrfHash: sha256('refresh-csrf'),
      expiresAt: new Date(Date.now() + 60_000).toISOString() });
    first.upsertConnection({ id: 'connection', tenant_id: tenant, buffer_account_id: 'account',
      access_token_ciphertext: encrypt('old-access', cfg.encryptionKey), refresh_token_ciphertext: encrypt('old-refresh', cfg.encryptionKey),
      access_expires_at: new Date(0).toISOString(), scopes: 'offline_access' });
    second = new Store(databasePath);
    const now = new Date();
    assert.equal(first.acquireTokenRefreshClaim('connection', 1, 'worker-one', now, new Date(now.getTime() + 10_000)), 'acquired');
    assert.equal(second.acquireTokenRefreshClaim('connection', 1, 'worker-two', now, new Date(now.getTime() + 10_000)), 'in_progress');
    assert.equal(first.startTokenRefresh('connection', 1, 'worker-one', now, new Date(now.getTime() + 10_000)), true);
    assert.equal(second.acquireTokenRefreshClaim('connection', 1, 'worker-two', now, new Date(now.getTime() + 10_000)), 'uncertain');

    first.upsertConnection({ id: 'replacement-id', tenant_id: tenant, buffer_account_id: 'account',
      access_token_ciphertext: encrypt('newer-access', cfg.encryptionKey), refresh_token_ciphertext: encrypt('newer-refresh', cfg.encryptionKey),
      access_expires_at: new Date(Date.now() + 3_600_000).toISOString(), scopes: 'offline_access' });
    assert.equal(second.commitTokenRefresh({ connectionId: 'connection', expectedVersion: 1, ownerId: 'worker-one',
      access: encrypt('stale-access', cfg.encryptionKey), refresh: encrypt('stale-refresh', cfg.encryptionKey),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(), scopes: 'offline_access' }), false);
    const connection = first.getConnection(tenant, 'connection')!;
    assert.equal(connection.token_version, 2);
    assert.equal(decrypt(connection.access_token_ciphertext, cfg.encryptionKey), 'newer-access');
    assert.equal(first.requireReauthIfVersion('connection', 1), false);
    assert.equal(first.getConnection(tenant, 'connection')!.status, 'active');
  } finally {
    second?.close();
    first?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('an expired refresh request claim fails closed without replaying a possibly consumed token', async () => {
  const { store, tenant } = setup();
  const cfg = config();
  store.upsertConnection({ id: 'connection', tenant_id: tenant, buffer_account_id: 'account',
    access_token_ciphertext: encrypt('expired', cfg.encryptionKey), refresh_token_ciphertext: encrypt('single-use-refresh', cfg.encryptionKey),
    access_expires_at: new Date(0).toISOString(), scopes: 'offline_access' });
  const old = new Date(Date.now() - 60_000);
  assert.equal(store.acquireTokenRefreshClaim('connection', 1, 'crashed-worker', old, new Date(old.getTime() + 1_000)), 'acquired');
  assert.equal(store.startTokenRefresh('connection', 1, 'crashed-worker', old, new Date(old.getTime() + 2_000)), true);
  let requests = 0;
  const client = new BufferClient(cfg, store, async () => { requests++; throw new Error('must not send'); });
  await assert.rejects(client.accessToken(store.getConnection(tenant, 'connection')!), /automatic replay is disabled/);
  assert.equal(requests, 0);
  assert.equal(store.getConnection(tenant, 'connection')!.status, 'reauthorization_required');
  store.close();
});

test('deterministic Buffer transport fixtures distinguish restrictions, DNS, and timeout without leaking details', async () => {
  const cases = [
    { error: Object.assign(new Error('private permission detail'), { cause: { code: 'EACCES' } }), kind: 'network', category: 'permission', code: 'EACCES' },
    { error: Object.assign(new Error('private DNS detail'), { code: 'ENOTFOUND' }), kind: 'network', category: 'dns', code: 'ENOTFOUND' },
    { error: Object.assign(new Error('private timeout detail'), { name: 'TimeoutError', code: 'ETIMEDOUT' }), kind: 'timeout', category: 'timeout', code: 'ETIMEDOUT' },
  ] as const;
  for (const fixture of cases) {
    const store = new Store(':memory:');
    const client = new BufferClient(config(), store, async () => { throw fixture.error; });
    await assert.rejects(client.rawGraphql('token', 'query GabelTransportFixture { account { id } }'), (error: BufferError) => {
      const diagnostic = safeBufferErrorDiagnostic(error);
      assert.equal(diagnostic.kind, fixture.kind);
      assert.equal(diagnostic.operationName, 'GabelTransportFixture');
      assert.deepEqual(diagnostic.details, { category: fixture.category, errorName: fixture.error.name, code: fixture.code });
      assert.equal(JSON.stringify(diagnostic).includes('private'), false);
      return true;
    });
    store.close();
  }

  await assert.rejects(tokenRequest(config(), new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'must-not-leak' }),
    async () => { throw Object.assign(new Error('private permission detail'), { cause: { code: 'EACCES' } }); }, 'BufferTokenRefresh'),
  (error: BufferError) => {
    const diagnostic = safeBufferErrorDiagnostic(error);
    assert.equal(diagnostic.kind, 'network');
    assert.equal(diagnostic.operationName, 'BufferTokenRefresh');
    assert.deepEqual(diagnostic.details, { category: 'permission', errorName: 'Error', code: 'EACCES' });
    assert.equal(JSON.stringify(diagnostic).includes('must-not-leak'), false);
    assert.equal(JSON.stringify(diagnostic).includes('private'), false);
    return true;
  });
});

test('GraphQL parser accepts data and retains request identifiers', async () => {
  const { store } = setup();
  const client = new BufferClient(config(), store, async () => response({ data: { account: { id: 'real' } } }, 200, { 'x-request-id': 'req-1' }));
  const result = await client.rawGraphql<{ account: { id: string } }>('token', 'query { account { id } }');
  assert.equal(result.data.account.id, 'real');
  assert.equal(result.requestId, 'req-1');
  store.close();
});

test('GraphQL failures retain only safe operation, HTTP, request, path, and extension diagnostics', async () => {
  const { store } = setup();
  const client = new BufferClient(config(), store, async () => response({ errors: [{
    message: 'Cannot query field "unsupported" on type "Post".',
    path: ['posts', 'edges', 0, 'node', 'unsupported'],
    extensions: { code: 'GRAPHQL_VALIDATION_FAILED', client_secret: 'must-not-leak' },
  }] }, 200, { 'x-request-id': 'safe-request-id' }));
  await assert.rejects(client.rawGraphql('token', 'query GabelDiagnostic { posts { unsupported } }'), (error: BufferError) => {
    assert.deepEqual(safeBufferErrorDiagnostic(error), {
      kind: 'graphql',
      message: 'Buffer returned GraphQL errors',
      operationName: 'GabelDiagnostic',
      httpStatus: 200,
      requestId: 'safe-request-id',
      retryAfter: undefined,
      details: [{
        message: 'Cannot query field "unsupported" on type "Post".',
        path: ['posts', 'edges', 0, 'node', 'unsupported'],
        extensions: { code: 'GRAPHQL_VALIDATION_FAILED', client_secret: '[REDACTED]' },
      }],
    });
    return true;
  });
  assert.equal(graphqlOperationName('query GabelDiagnostic { account { id } }'), 'GabelDiagnostic');
  store.close();
});

test('scheduled-post metadata selects type through the documented polymorphic interface', () => {
  assert.match(POST_LIST_QUERY, /metadata\s*\{\s*\.\.\. on CommonPostMetadata\s*\{\s*type\s*\}\s*\}/);
  assert.doesNotMatch(POST_LIST_QUERY, /metadata\s*\{\s*type\s*\}/);
});

test('partial GraphQL responses and HTTP rate limits are not treated as success', async () => {
  const { store } = setup();
  const gql = new BufferClient(config(), store, async () => response({ data: { account: { id: 'partial' } }, errors: [{ message: 'No', extensions: { code: 'FORBIDDEN' } }] }));
  await assert.rejects(gql.rawGraphql('token', 'query X { account { id } }'), (error: BufferError) => error.kind === 'graphql');
  const limited = new BufferClient(config(), store, async () => response({ errors: [{ message: 'slow' }] }, 429, { 'retry-after': '12' }));
  await assert.rejects(limited.rawGraphql('token', 'query X { account { id } }'), (error: BufferError) => error.kind === 'rate_limit' && error.retryAfter === 12);
  store.close();
});

test('discovery follows cursor pagination and handles an empty account honestly', async () => {
  const { store, tenant } = setup();
  const cfg = config();
  store.upsertConnection({ id: 'connection', tenant_id: tenant, buffer_account_id: 'account', access_token_ciphertext: encrypt('token', cfg.encryptionKey),
    refresh_token_ciphertext: null, access_expires_at: new Date(Date.now() + 3600_000).toISOString(), scopes: 'account:read posts:read' });
  const pages = [post({ id: 'one' }), post({ id: 'two' })];
  const client = new BufferClient(cfg, store, async (_input, init) => {
    const payload = JSON.parse(String(init?.body));
    if (payload.query.includes('GabelOrganizations')) return response({ data: { account: { organizations: [{ id: 'org', name: 'Org' }] } } });
    if (payload.query.includes('GabelChannels')) return response({ data: { channels: [] } });
    const index = payload.variables.after ? 1 : 0;
    return response({ data: { posts: { edges: [{ node: pages[index] }], pageInfo: { hasNextPage: index === 0, endCursor: index === 0 ? 'next' : null } } } });
  });
  const found = await client.discover(tenant, 'connection');
  assert.equal(found.organizations[0].channels.length, 0);
  assert.deepEqual(found.posts.map((p) => p.id), ['one', 'two']);
  store.close();
});

test('missing required document metadata blocks edit payload construction', () => {
  const broken = post({ assets: [{ id: 'doc', type: 'document', mimeType: 'application/pdf', source: 'https://media.example/doc.pdf', thumbnail: '', document: { title: null, thumbnails: [] } }] });
  assert.throws(() => buildCompleteAssetList(broken, new Map([[0, 'https://new.example/doc.pdf']])), /cannot be losslessly reconstructed/);
});

test('fresh Buffer capabilities must explicitly authorize post updates', () => {
  assert.doesNotThrow(() => assertPostEditable(post()));
  assert.throws(() => assertPostEditable(post({ allowedActions: [] })), /does not currently authorize/);
  assert.throws(() => assertPostEditable(post({ status: 'sent' })), /Only scheduled posts/);
});

test('edit payload preserves ordered multi-asset metadata and replaces only selected URL', () => {
  const assets = buildCompleteAssetList(post(), new Map([[1, 'https://new.example/b.mp4']]));
  assert.equal((assets[0] as { image: { url: string } }).image.url, 'https://media.example/a.jpg');
  assert.deepEqual((assets[0] as { image: { metadata: unknown } }).image.metadata, { altText: 'A', animatedThumbnail: undefined, userTags: [{ handle: 'person', x: 0.5, y: 0.4 }] });
  assert.equal((assets[1] as { video: { url: string } }).video.url, 'https://new.example/b.mp4');
});

test('image replacement omits stale thumbnails while preserving unrelated assets and order', () => {
  const before = post();
  const replaced = buildCompleteAssetList(before, new Map([[0, 'https://new.example/replacement.jpg']]));
  assert.equal((replaced[0] as { image: { url: string } }).image.url, 'https://new.example/replacement.jpg');
  assert.equal((replaced[0] as { image: { thumbnailUrl?: string } }).image.thumbnailUrl, undefined);
  assert.equal((replaced[1] as { video: { url: string } }).video.url, before.assets[1].source);

  const untouched = buildCompleteAssetList(before, new Map([[1, 'https://new.example/replacement.mp4']]));
  assert.equal((untouched[0] as { image: { thumbnailUrl?: string } }).image.thumbnailUrl, before.assets[0].thumbnail);

  const withoutThumbnail = post({ assets: [{ ...before.assets[0], thumbnail: '' }, before.assets[1]] });
  const missing = buildCompleteAssetList(withoutThumbnail, new Map([[0, 'https://new.example/no-thumb.jpg']]));
  assert.equal((missing[0] as { image: { thumbnailUrl?: string } }).image.thumbnailUrl, undefined);
});

test('verification catches scheduling and unrelated metadata changes', () => {
  const before = post();
  const intended = buildCompleteAssetList(before, new Map([[0, 'https://new.example/a.jpg']]));
  const changed = post({ dueAt: '2026-11-02T12:00:00.000Z', text: 'changed', assets: [
    { ...before.assets[0], source: 'https://new.example/a.jpg' }, before.assets[1],
  ] });
  const result = comparePost(before, changed, intended);
  assert.equal(result.matches, false);
  assert.ok(result.discrepancies.some((item) => item.startsWith('dueAt changed')));
  assert.ok(result.discrepancies.includes('post text changed'));
});

test('verification accepts an unchanged scheduled status and exact post identity', () => {
  const before = post();
  const intended = buildCompleteAssetList(before, new Map([[0, 'https://new.example/a.jpg']]));
  const after = post({ assets: [{ ...before.assets[0], source: 'https://new.example/a.jpg' }, before.assets[1]] });
  assert.deepEqual(comparePost(before, after, intended), { matches: true, discrepancies: [] });
});

test('verification rejects an unexpected post-status change', () => {
  const before = post();
  const intended = buildCompleteAssetList(before, new Map());
  const result = comparePost(before, post({ status: 'sending' }), intended);
  assert.equal(result.matches, false);
  assert.ok(result.discrepancies.includes('post status changed'));
});

test('verification rejects a partial fresh post response with missing status', () => {
  const before = post();
  const after = { ...post(), status: undefined } as unknown as BufferPost;
  const result = comparePost(before, after, buildCompleteAssetList(before, new Map()));
  assert.equal(result.matches, false);
  assert.ok(result.discrepancies.includes('fresh post status is missing'));
});

test('verification rejects a fresh post response with an unknown status', () => {
  const before = post();
  const result = comparePost(before, post({ status: 'mystery-status' }), buildCompleteAssetList(before, new Map()));
  assert.equal(result.matches, false);
  assert.ok(result.discrepancies.includes('fresh post status is unknown'));
});

test('verification rejects a changed post identity', () => {
  const before = post();
  const result = comparePost(before, post({ id: 'different-post' }), buildCompleteAssetList(before, new Map()));
  assert.equal(result.matches, false);
  assert.ok(result.discrepancies.includes('post identity changed'));
});

test('post fingerprint detects changes between preparation and confirmation', () => {
  assert.notEqual(fingerprintPost(post()), fingerprintPost(post({ updatedAt: 'later' })));
});

const successfulImageProbe = (overrides: Partial<MediaProbeResult> = {}): MediaProbeResult => ({
  outcome: 'reachable', httpStatus: 206, contentType: 'image/jpeg', fileSizeBytes: 40_000,
  declaredFormat: 'jpeg', detectedFormat: 'jpeg', dimensions: { width: 688, height: 689 }, inspectionDigest: 'prefix-digest',
  dnsLookups: 1, resolvedAddressCount: 1, addressFamilies: [4], allAddressesPublic: true,
  redirects: 0, reason: 'Media host returned a successful response', durationMs: 10, ...overrides,
});

function replacementValidationHarness() {
  const { store, tenant } = setup();
  const cfg = config();
  const before = post({ assets: [post().assets[0]] });
  store.upsertConnection({ id: 'connection', tenant_id: tenant, buffer_account_id: 'account', access_token_ciphertext: encrypt('access', cfg.encryptionKey),
    refresh_token_ciphertext: null, access_expires_at: new Date(Date.now() + 60_000).toISOString(), scopes: 'posts:write' });
  store.replaceDiscovery(tenant, 'connection', [{ id: 'org', name: 'Org', channels: [{ id: before.channelId, name: 'X', service: 'twitter', isDisconnected: false, isLocked: false }] }]);
  store.replacePosts(tenant, 'connection', 'org', [before]);
  let postReads = 0;
  let mutationSent = false;
  const fake = {
    getPost: async () => { postReads++; return { post: before }; },
    graphql: async (_tenantId: string, _connectionId: string, query: string) => {
      if (query.includes('GabelReplacementChannelConfiguration')) return { data: { configuration: { channels: [{ channelId: before.channelId, service: 'twitter', channelType: 'profile' }] } } };
      if (query.includes('GabelReplacementMediaFormats')) return { data: { __type: { enumValues: [{ name: 'jpeg' }, { name: 'png' }, { name: 'gif' }] } } };
      mutationSent = true;
      return { data: { editPost: { post: before } } };
    },
  };
  return { store, tenant, before, fake: fake as unknown as BufferClient, postReads: () => postReads, mutationSent: () => mutationSent };
}

test('edit preparation requires a fresh reachable, supported, size-safe, dimension-safe image', async () => {
  const harness = replacementValidationHarness();
  const replacements = new Map([[0, 'https://public.example/replacement.jpg']]);
  const cases: Array<[string, MediaProbeResult]> = [
    ['confirmed unsuccessful', successfulImageProbe({ outcome: 'unreachable', httpStatus: 404 })],
    ['inconclusive', successfulImageProbe({ outcome: 'error', errorCategory: 'timeout', httpStatus: undefined })],
    ['not allowed', successfulImageProbe({ outcome: 'unsafe', httpStatus: undefined })],
    ['MIME type', successfulImageProbe({ contentType: 'image/png', declaredFormat: 'png', detectedFormat: 'jpeg' })],
    ['5 MB', successfulImageProbe({ fileSizeBytes: 5_000_001 })],
    ['8192', successfulImageProbe({ dimensions: { width: 8_193, height: 100 } })],
    ['8192', successfulImageProbe({ dimensions: { width: 0, height: 100 } })],
  ];
  for (const [message, result] of cases) {
    await assert.rejects(validateImageReplacements({ store: harness.store, buffer: harness.fake, tenantId: harness.tenant,
      connectionId: 'connection', post: harness.before, replacements, probe: async () => result }), new RegExp(message, 'i'));
  }
  assert.equal((harness.store.db.prepare('SELECT COUNT(*) count FROM edit_intents').get() as { count: number }).count, 0);

  const checkedAt = new Date().toISOString();
  harness.store.saveMediaCheck({ tenantId: harness.tenant, connectionId: 'connection', postId: harness.before.id,
    status: 'confirmed_problem', checkedCount: 1, checkedAt,
    summary: [{ position: 0, type: 'image', label: 'CONFIRMED PROBLEM', detail: 'The server returned an unsuccessful response.', httpStatus: 410 }] });
  const edits = new EditService(harness.store, harness.fake, { probe: async () => successfulImageProbe() });
  const intentId = await edits.prepare(harness.tenant, 'connection', harness.before.id, replacements);
  const row = harness.store.db.prepare('SELECT intended_assets_json,outcome_json FROM edit_intents WHERE id=?').get(intentId) as Record<string, string>;
  assert.equal((JSON.parse(row.intended_assets_json)[0] as { image: { thumbnailUrl?: string } }).image.thumbnailUrl, undefined);
  const outcome = JSON.parse(row.outcome_json) as { replacementValidations: unknown[]; problemEvidence: { checkedAt: string; summary: Array<{ httpStatus: number }> } };
  assert.equal(outcome.replacementValidations.length, 1);
  assert.equal(outcome.problemEvidence.checkedAt, checkedAt);
  assert.equal(outcome.problemEvidence.summary[0].httpStatus, 410);
  assert.equal(harness.mutationSent(), false);
  harness.store.close();
});

test('replacement validation expires and detects changed media evidence', () => {
  const base: ReplacementValidationEvidence = { position: 0, validatedAt: new Date(1_000).toISOString(), expiresAt: new Date(601_000).toISOString(),
    channelService: 'twitter', requirementsSource: 'official-buffer-x-static-image-guidance', mediaFingerprint: 'first', format: 'jpeg',
    fileSizeBytes: 100, dimensions: { width: 10, height: 10 } };
  assert.throws(() => assertFreshMatchingValidation([base], [base], 601_000), /stale/);
  assert.throws(() => assertFreshMatchingValidation([base], [{ ...base, validatedAt: new Date(2_000).toISOString(), expiresAt: new Date(602_000).toISOString(), mediaFingerprint: 'changed' }], 2_000), /changed/);
});

test('fresh post changes abort a prepared edit before revalidation or mutation', async () => {
  const harness = replacementValidationHarness();
  let read = 0;
  const fake = { ...harness.fake,
    getPost: async () => ({ post: read++ === 0 ? harness.before : { ...harness.before, updatedAt: 'changed-after-preview' } }),
  } as unknown as BufferClient;
  const edits = new EditService(harness.store, fake, { probe: async () => successfulImageProbe() });
  const intentId = await edits.prepare(harness.tenant, 'connection', harness.before.id, new Map([[0, 'https://public.example/replacement.jpg']]));
  await assert.rejects(edits.confirm(harness.tenant, intentId, `EDIT POST ${harness.before.id}`), /Post changed after preparation/);
  assert.equal(harness.mutationSent(), false);
  assert.equal((harness.store.db.prepare('SELECT status FROM edit_intents WHERE id=?').get(intentId) as { status: string }).status, 'aborted_stale');
  harness.store.close();
});

test('successful edit response with failed fresh post verification remains ambiguous', async () => {
  const harness = replacementValidationHarness();
  let reads = 0;
  const fake = { ...harness.fake,
    getPost: async () => {
      reads++;
      if (reads <= 2) return { post: harness.before };
      throw new BufferError('fresh verification unavailable', 'network');
    },
  } as unknown as BufferClient;
  const edits = new EditService(harness.store, fake, { probe: async () => successfulImageProbe() });
  const intentId = await edits.prepare(harness.tenant, 'connection', harness.before.id,
    new Map([[0, 'https://public.example/replacement.jpg']]));
  await assert.rejects(edits.confirm(harness.tenant, intentId, `EDIT POST ${harness.before.id}`),
    /verification retrieval failed/);
  const row = harness.store.db.prepare('SELECT status FROM edit_intents WHERE id=?').get(intentId) as { status: string };
  assert.equal(row.status, 'ambiguous');
  assert.equal(harness.mutationSent(), true);
  harness.store.close();
});

test('successful edit response with changed fresh post status remains ambiguous', async () => {
  const harness = replacementValidationHarness();
  const replacementUrl = 'https://public.example/replacement.jpg';
  const after = { ...harness.before, status: 'sending',
    assets: [{ ...harness.before.assets[0], source: replacementUrl }] };
  let reads = 0;
  const baseGraphql = harness.fake.graphql.bind(harness.fake);
  const fake = { ...harness.fake,
    getPost: async () => ({ post: ++reads <= 2 ? harness.before : after }),
    graphql: async (...args: Parameters<BufferClient['graphql']>) => {
      const result = await baseGraphql(...args);
      return args[2].includes('GabelEditPost') ? { ...result, data: { editPost: { post: after } } } : result;
    },
  } as unknown as BufferClient;
  const edits = new EditService(harness.store, fake, { probe: async () => successfulImageProbe() });
  const intentId = await edits.prepare(harness.tenant, 'connection', harness.before.id, new Map([[0, replacementUrl]]));
  const comparison = await edits.confirm(harness.tenant, intentId, `EDIT POST ${harness.before.id}`);
  assert.equal(comparison.matches, false);
  assert.ok(comparison.discrepancies.includes('post status changed'));
  const row = harness.store.db.prepare('SELECT status FROM edit_intents WHERE id=?').get(intentId) as { status: string };
  assert.equal(row.status, 'ambiguous');
  assert.equal(harness.mutationSent(), true);
  harness.store.close();
});

test('two simultaneous approvals atomically claim one intent and send one edit mutation', async () => {
  const harness = replacementValidationHarness();
  let mutationCalls = 0;
  const baseGraphql = harness.fake.graphql.bind(harness.fake);
  const fake = { ...harness.fake, graphql: async (...args: Parameters<BufferClient['graphql']>) => {
    if (args[2].includes('GabelEditPost')) mutationCalls++;
    return baseGraphql(...args);
  }} as unknown as BufferClient;
  const edits = new EditService(harness.store, fake, { probe: async () => successfulImageProbe() });
  const intentId = await edits.prepare(harness.tenant, 'connection', harness.before.id,
    new Map([[0, 'https://public.example/replacement.jpg']]));
  const results = await Promise.allSettled([
    edits.confirm(harness.tenant, intentId, `EDIT POST ${harness.before.id}`),
    edits.confirm(harness.tenant, intentId, `EDIT POST ${harness.before.id}`),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(mutationCalls, 1);
  const claim = harness.store.db.prepare('SELECT state,COUNT(*) count FROM edit_intent_claims WHERE intent_id=?')
    .get(intentId) as { state: string; count: number };
  assert.equal(claim.count, 1);
  assert.equal(claim.state, 'ambiguous');
  harness.store.close();
});

test('claimed, expired, and ambiguous edit intents never replay a possible mutation', async () => {
  const harness = replacementValidationHarness();
  const edits = new EditService(harness.store, harness.fake, { probe: async () => successfulImageProbe() });
  const intentId = await edits.prepare(harness.tenant, 'connection', harness.before.id,
    new Map([[0, 'https://public.example/replacement.jpg']]));
  assert.ok(harness.store.claimEditIntent(harness.tenant, intentId, harness.before.id, 'crashed-worker'));
  harness.store.db.prepare('UPDATE edit_intent_claims SET expires_at=? WHERE intent_id=?').run(new Date(0).toISOString(), intentId);
  await assert.rejects(edits.confirm(harness.tenant, intentId, `EDIT POST ${harness.before.id}`), /already claimed/);
  assert.equal(harness.mutationSent(), false);

  const second = await edits.prepare(harness.tenant, 'connection', harness.before.id,
    new Map([[0, 'https://public.example/replacement.jpg']]));
  let mutationCalls = 0;
  const ambiguousBuffer = { ...harness.fake,
    graphql: async (...args: Parameters<BufferClient['graphql']>) => {
      if (args[2].includes('GabelEditPost')) {
        mutationCalls++;
        throw new BufferError('response lost', 'network');
      }
      return harness.fake.graphql(...args);
    },
  } as unknown as BufferClient;
  const ambiguousEdits = new EditService(harness.store, ambiguousBuffer, { probe: async () => successfulImageProbe() });
  await assert.rejects(ambiguousEdits.confirm(harness.tenant, second, `EDIT POST ${harness.before.id}`), /response lost/);
  await assert.rejects(ambiguousEdits.confirm(harness.tenant, second, `EDIT POST ${harness.before.id}`), /already used/);
  assert.equal(mutationCalls, 1);
  assert.equal((harness.store.db.prepare('SELECT state FROM edit_intent_claims WHERE intent_id=?').get(second) as { state: string }).state, 'ambiguous');

  const interrupted = await edits.prepare(harness.tenant, 'connection', harness.before.id,
    new Map([[0, 'https://public.example/replacement.jpg']]));
  assert.ok(harness.store.claimEditIntent(harness.tenant, interrupted, harness.before.id, 'interrupted-worker'));
  assert.equal(harness.store.startEditMutation(interrupted, 'interrupted-worker'), true);
  harness.store.db.prepare('UPDATE edit_intent_claims SET expires_at=? WHERE intent_id=?').run(new Date(0).toISOString(), interrupted);
  await assert.rejects(edits.confirm(harness.tenant, interrupted, `EDIT POST ${harness.before.id}`), /already claimed/);
  assert.equal((harness.store.db.prepare('SELECT status FROM edit_intents WHERE id=?').get(interrupted) as { status: string }).status, 'ambiguous');
  assert.equal((harness.store.db.prepare('SELECT state FROM edit_intent_claims WHERE intent_id=?').get(interrupted) as { state: string }).state, 'ambiguous');
  assert.equal(mutationCalls, 1);
  harness.store.close();
});

test('edit intent claims reject expired and cross-tenant approvals before Buffer work', async () => {
  const harness = replacementValidationHarness();
  const other = randomUUID();
  harness.store.createTenant(other);
  const edits = new EditService(harness.store, harness.fake, { probe: async () => successfulImageProbe() });
  const intentId = await edits.prepare(harness.tenant, 'connection', harness.before.id,
    new Map([[0, 'https://public.example/replacement.jpg']]));
  await assert.rejects(edits.confirm(other, intentId, `EDIT POST ${harness.before.id}`), /belongs to another tenant/);
  harness.store.db.prepare('UPDATE edit_intents SET expires_at=? WHERE id=?').run(new Date(0).toISOString(), intentId);
  await assert.rejects(edits.confirm(harness.tenant, intentId, `EDIT POST ${harness.before.id}`), /expired/);
  assert.equal(harness.mutationSent(), false);
  assert.equal((harness.store.db.prepare('SELECT COUNT(*) count FROM edit_intent_claims').get() as { count: number }).count, 0);
  harness.store.close();
});

test('a network exception during mutation is classified as ambiguous', () => {
  assert.equal(classifyMutationException(new BufferError('lost response', 'network')), 'ambiguous');
  assert.equal(classifyMutationException(new BufferError('timed out', 'timeout')), 'ambiguous');
  assert.equal(classifyMutationException(new BufferError('partial GraphQL result', 'graphql')), 'ambiguous');
  assert.equal(classifyMutationException(new BufferError('not authorized', 'auth')), 'failure');
});

test('tenant isolation applies to connection lookup and edit intents', () => {
  const { store, tenant } = setup();
  const other = randomUUID();
  store.createTenant(other);
  store.upsertConnection({ id: 'private', tenant_id: tenant, buffer_account_id: 'account', access_token_ciphertext: 'cipher', refresh_token_ciphertext: null,
    access_expires_at: new Date().toISOString(), scopes: '' });
  assert.equal(store.getConnection(other, 'private'), undefined);
  assert.ok(store.getConnection(tenant, 'private'));
  store.replaceDiscovery(tenant, 'private', [{ id: 'org', name: 'Org', channels: [] }]);
  store.replacePosts(tenant, 'private', 'org', [post()]);
  assert.equal(store.hasCachedPost(tenant, 'private', post().id), true);
  assert.equal(store.hasCachedPost(other, 'private', post().id), false);
  store.close();
});

test('media check summaries are tenant-scoped, time-bounded, and drive the dashboard state', () => {
  const { store, tenant } = setup();
  const other = randomUUID();
  store.createTenant(other);
  store.upsertConnection({ id: 'connection', tenant_id: tenant, buffer_account_id: 'account', access_token_ciphertext: 'cipher',
    refresh_token_ciphertext: null, access_expires_at: new Date(Date.now() + 60_000).toISOString(), scopes: 'posts:read' });
  store.replacePosts(tenant, 'connection', 'org', [post()]);
  const now = new Date('2026-11-06T12:00:00.000Z');
  store.saveMediaCheck({ tenantId: tenant, connectionId: 'connection', postId: post().id, status: 'confirmed_problem',
    checkedCount: 1, checkedAt: now.toISOString(), summary: [{ position: 0, label: 'CONFIRMED PROBLEM', httpStatus: 410 }] });
  assert.deepEqual(store.getFreshConfirmedProblemPositions(tenant, 'connection', post().id, now), [0]);
  assert.equal(store.hasFreshConfirmedProblem(tenant, 'connection', post().id, new Date(now.getTime() + 9 * 60_000)), true);
  assert.equal(store.hasFreshConfirmedProblem(tenant, 'connection', post().id, new Date(now.getTime() + 11 * 60_000)), false);
  assert.equal(store.hasFreshConfirmedProblem(other, 'connection', post().id, now), false);
  const dashboardPost = store.listDashboard(tenant).posts[0] as Record<string, unknown>;
  assert.equal(dashboardPost.media_status, 'confirmed_problem');
  assert.equal(dashboardPost.checked_count, 1);
  store.saveMediaCheck({ tenantId: tenant, connectionId: 'connection', postId: post().id, status: 'could_not_verify',
    checkedCount: 1, checkedAt: new Date(now.getTime() + 1_000).toISOString(), summary: [] });
  assert.equal(store.hasFreshConfirmedProblem(tenant, 'connection', post().id, new Date(now.getTime() + 2_000)), false);
  store.close();
});

test('read-only verification selects only the explicit authenticated tenant connection', () => {
  const store = new Store(':memory:');
  const firstTenant = randomUUID();
  const secondTenant = randomUUID();
  for (const [tenant, suffix] of [[firstTenant, 'first'], [secondTenant, 'second']] as const) {
    store.createTenant(tenant);
    store.createSession({ idHash: sha256(`session-${suffix}`), tenantId: tenant, csrfHash: sha256(`csrf-${suffix}`),
      expiresAt: new Date(Date.now() + 60_000).toISOString() });
    store.upsertConnection({ id: `connection-${suffix}`, tenant_id: tenant, buffer_account_id: `account-${suffix}`,
      access_token_ciphertext: `cipher-${suffix}`, refresh_token_ciphertext: `refresh-${suffix}`,
      access_expires_at: new Date(Date.now() + 60_000).toISOString(), scopes: 'account:read posts:read' });
  }
  assert.equal(store.requireAuthenticatedTenantConnection(secondTenant).id, 'connection-second');
  store.close();
});

test('read-only verification fails closed without a current authenticated tenant context', () => {
  const store = new Store(':memory:');
  const tenant = randomUUID();
  store.createTenant(tenant);
  store.createSession({ idHash: sha256('expired-session'), tenantId: tenant, csrfHash: sha256('expired-csrf'),
    expiresAt: new Date(0).toISOString() });
  store.upsertConnection({ id: 'connection', tenant_id: tenant, buffer_account_id: 'account',
    access_token_ciphertext: 'cipher', refresh_token_ciphertext: 'refresh',
    access_expires_at: new Date(Date.now() + 60_000).toISOString(), scopes: 'account:read posts:read' });
  assert.throws(() => store.requireAuthenticatedTenantConnection(''), /explicit authenticated tenant/);
  assert.throws(() => store.requireAuthenticatedTenantConnection(tenant), /no unexpired browser session/);
  store.close();
});

test('explicit authorization is required before an edit mutation', async () => {
  const { store, tenant } = setup();
  const otherTenant = randomUUID();
  store.createTenant(otherTenant);
  const before = post();
  const cfg = config();
  store.upsertConnection({ id: 'connection', tenant_id: tenant, buffer_account_id: 'account', access_token_ciphertext: encrypt('access', cfg.encryptionKey),
    refresh_token_ciphertext: null, access_expires_at: new Date(Date.now() + 60_000).toISOString(), scopes: 'posts:write' });
  store.db.prepare(`INSERT INTO edit_intents(id,tenant_id,connection_id,post_id,before_json,intended_assets_json,before_fingerprint,status,created_at,expires_at)
    VALUES(?,?,?,?,?,?,?,'pending',?,?)`).run('intent', tenant, 'connection', before.id, JSON.stringify(before),
      JSON.stringify(buildCompleteAssetList(before, new Map([[0, 'https://media.example/new.jpg']]))), fingerprintPost(before),
      new Date().toISOString(), new Date(Date.now() + 60_000).toISOString());
  let called = false;
  const fake = { getPost: async () => { called = true; return { post: before }; }, graphql: async () => { called = true; throw new Error('must not run'); } };
  const edits = new EditService(store, fake as unknown as BufferClient);
  await assert.rejects(edits.confirm(otherTenant, 'intent', `EDIT POST ${before.id}`), /belongs to another tenant/);
  await assert.rejects(edits.confirm(tenant, 'intent', 'yes'), /exactly match/);
  assert.equal(called, false);
  store.close();
});

test('account deletion cascades sessions, credentials, cached data, intents, and evidence', () => {
  const { store, tenant } = setup();
  const cfg = config();
  store.upsertConnection({ id: 'connection', tenant_id: tenant, buffer_account_id: 'account', access_token_ciphertext: encrypt('access', cfg.encryptionKey),
    refresh_token_ciphertext: encrypt('refresh', cfg.encryptionKey), access_expires_at: new Date(Date.now() + 60_000).toISOString(), scopes: 'offline_access' });
  store.addEvidence({ id: 'event', tenantId: tenant, operation: 'test', outcome: 'success', sanitized: {} });
  assert.equal(store.deleteTenant(tenant), true);
  for (const table of ['tenants', 'browser_sessions', 'buffer_connections', 'organizations', 'channels', 'posts', 'post_media_checks', 'assets', 'edit_intents', 'evidence_events']) {
    const row = store.db.prepare(`SELECT COUNT(*) count FROM ${table}`).get() as { count: number };
    assert.equal(row.count, 0, `${table} should be empty`);
  }
  store.close();
});

test('disconnect is tenant-scoped and deletes local credentials and connection cache', () => {
  const { store, tenant } = setup();
  const other = randomUUID();
  const cfg = config();
  store.createTenant(other);
  store.upsertConnection({ id: 'connection', tenant_id: tenant, buffer_account_id: 'account', access_token_ciphertext: encrypt('access', cfg.encryptionKey),
    refresh_token_ciphertext: encrypt('refresh', cfg.encryptionKey), access_expires_at: new Date(Date.now() + 60_000).toISOString(), scopes: 'offline_access' });
  assert.equal(store.disconnectConnection(other, 'connection'), false);
  assert.ok(store.getConnection(tenant, 'connection'));
  assert.equal(store.disconnectConnection(tenant, 'connection'), true);
  assert.equal(store.getConnection(tenant, 'connection'), undefined);
  store.close();
});

test('sync cache minimizes post content and media records', () => {
  const { store, tenant } = setup();
  const cfg = config();
  store.upsertConnection({ id: 'connection', tenant_id: tenant, buffer_account_id: 'account', access_token_ciphertext: encrypt('access', cfg.encryptionKey),
    refresh_token_ciphertext: null, access_expires_at: new Date(Date.now() + 60_000).toISOString(), scopes: 'posts:read' });
  store.replacePosts(tenant, 'connection', 'org', [post()]);
  const cached = store.db.prepare('SELECT text_content,sanitized_json FROM posts').get() as { text_content: string; sanitized_json: string };
  assert.equal(cached.text_content, '');
  assert.deepEqual(JSON.parse(cached.sanitized_json), { assetCount: 2 });
  assert.equal((store.db.prepare('SELECT COUNT(*) count FROM assets').get() as { count: number }).count, 0);
  store.close();
});

test('media destination policy blocks SSRF targets and validates redirects', async () => {
  const privateResolver = async () => ['169.254.169.254'];
  const publicResolver = async () => ['93.184.216.34'];
  await assert.rejects(validatePublicMediaUrl('https://metadata.example/latest', privateResolver), /prohibited/);
  await assert.rejects(validatePublicMediaUrl('https://127.0.0.1/media.jpg', publicResolver), /prohibited/);
  await assert.rejects(validatePublicMediaUrl('http://example.com/media.jpg', publicResolver), /HTTPS/);
  await assert.rejects(validateMediaRedirect(new URL('https://example.com/media'), 'https://10.0.0.4/secret', publicResolver), /prohibited/);
  assert.equal((await validateMediaRedirect(new URL('https://example.com/media'), '/next', publicResolver)).href, 'https://example.com/next');
  assert.equal(isProhibitedNetworkAddress('::1'), true);
  assert.equal(isProhibitedNetworkAddress('8.8.8.8'), false);
});

test('media probes pin validated DNS and never follow a redirect to a private address', async () => {
  const requested: string[] = [];
  const resolver = async (hostname: string) => hostname === 'public.example' ? ['93.184.216.34'] : ['169.254.169.254'];
  const result = await probeMediaUrl('https://public.example/media.jpg', {
    resolver,
    requester: async (_url, address) => {
      requested.push(address);
      return { status: 302, location: 'https://metadata.example/latest' };
    },
  });
  assert.equal(result.outcome, 'unsafe');
  assert.deepEqual(requested, ['93.184.216.34']);
  assert.equal(JSON.stringify(result).includes('public.example'), false);
});

test('media probes report bounded, URL-free reachability and redirect failures', async () => {
  const resolver = async () => ['93.184.216.34'];
  const reached = await probeMediaUrl('https://media.example/a.jpg', {
    resolver, requester: async () => ({ status: 206, contentType: 'image/jpeg', contentLength: 1 }),
  });
  assert.equal(reached.outcome, 'reachable');
  assert.equal(reached.httpStatus, 206);
  assert.equal(reached.contentType, 'image/jpeg');
  assert.equal(reached.contentLength, 1);
  assert.equal(reached.redirects, 0);
  assert.equal(reached.reason, 'Media host returned a successful response');
  assert.ok(reached.durationMs >= 0);
  const limited = await probeMediaUrl('https://media.example/a.jpg', {
    resolver, maxRedirects: 0, requester: async () => ({ status: 302, location: '/again' }),
  });
  assert.equal(limited.outcome, 'unreachable');
  assert.match(limited.reason, /redirect limit/);
  const failed = await probeMediaUrl('https://media.example/a.jpg', {
    resolver, requester: async () => { throw new Error('secret host detail'); },
  });
  assert.equal(failed.outcome, 'error');
  assert.equal(JSON.stringify(failed).includes('secret'), false);
});

test('media diagnostics distinguish DNS, timeout, TLS, and unsupported formats', async () => {
  const publicResolver = async () => ['93.184.216.34'];
  const dns = await probeMediaUrl('https://dns.example/a.jpg', {
    resolver: async () => { throw Object.assign(new Error('private resolver detail'), { code: 'ENOTFOUND' }); },
  });
  assert.equal(dns.outcome, 'error');
  assert.equal(dns.errorCategory, 'dns');
  assert.equal(JSON.stringify(dns).includes('private resolver detail'), false);
  const timeout = await probeMediaUrl('https://timeout.example/a.jpg', {
    resolver: publicResolver, requester: async () => { throw Object.assign(new Error('secret'), { code: 'ETIMEDOUT' }); },
  });
  assert.equal(timeout.errorCategory, 'timeout');
  const tls = await probeMediaUrl('https://tls.example/a.jpg', {
    resolver: publicResolver, requester: async () => { throw Object.assign(new Error('secret certificate'), { code: 'CERT_HAS_EXPIRED' }); },
  });
  assert.equal(tls.errorCategory, 'tls');
  assert.equal(classifyMediaContentType('image/webp; charset=binary'), 'image');
  assert.equal(classifyMediaContentType('video/mp4'), 'video');
  assert.equal(classifyMediaContentType('application/pdf'), 'document');
  assert.equal(classifyMediaContentType('text/html'), 'unsupported');
  assert.equal(classifyMediaContentType(undefined), 'unknown');
});

test('deterministic HTTP 410 media fixture is a confirmed problem', async () => {
  const result = await probeMediaUrl('https://gone.example/original.png', {
    resolver: async () => ['93.184.216.34'],
    requester: async () => ({ status: 410, contentType: 'text/plain', bodyPrefix: Buffer.from('Gone') }),
  });
  assert.equal(result.outcome, 'unreachable');
  assert.equal(result.httpStatus, 410);
  assert.equal(publicMediaStatus(result).label, 'CONFIRMED PROBLEM');
});

test('public media results clearly distinguish confirmed, inconclusive, unsupported, and ready states', () => {
  assert.equal(publicMediaStatus(successfulImageProbe({ outcome: 'unreachable', httpStatus: 404 })).label, 'CONFIRMED PROBLEM');
  assert.equal(publicMediaStatus(successfulImageProbe({ outcome: 'error', errorCategory: 'dns', httpStatus: undefined })).label, 'COULD NOT VERIFY');
  assert.equal(publicMediaStatus(successfulImageProbe({ contentType: 'text/html', declaredFormat: 'unknown', detectedFormat: 'unknown' })).label, 'UNSUPPORTED FILE');
  assert.equal(publicMediaStatus(successfulImageProbe()).label, 'READY');
  for (const result of [
    publicMediaStatus(successfulImageProbe({ outcome: 'unreachable', httpStatus: 410 })),
    publicMediaStatus(successfulImageProbe({ outcome: 'error', httpStatus: undefined })),
    publicMediaStatus(successfulImageProbe()),
  ]) assert.doesNotMatch(result.detail, /guarantee|will publish|future availability/i);
});

test('media validation derives total size and verifies image signatures independently of URL extensions', async () => {
  const webpSignature = Buffer.from('524946460000000057454250', 'hex');
  const result = await probeMediaUrl('https://media.example/not-an-extension.bin', {
    resolver: async () => ['93.184.216.34'],
    requester: async () => ({ status: 206, contentType: 'image/webp', contentLength: 16,
      fileSizeBytes: 456_789, signature: webpSignature }),
  });
  assert.equal(result.outcome, 'reachable');
  assert.equal(result.declaredFormat, 'webp');
  assert.equal(result.detectedFormat, 'webp');
  assert.equal(result.fileSizeBytes, 456_789);
  assert.equal(result.allAddressesPublic, true);
  assert.deepEqual(result.addressFamilies, [4]);
  assert.equal(mediaFormatFromContentType('image/jpeg; charset=binary'), 'jpeg');
  assert.equal(detectImageSignature(Buffer.from('ffd8ff00', 'hex')), 'jpeg');
  assert.equal(detectImageSignature(Buffer.from('89504e470d0a1a0a', 'hex')), 'png');
  assert.equal(detectImageSignature(Buffer.from('GIF89a', 'ascii')), 'gif');
  assert.equal(detectImageSignature(Buffer.from('not an image', 'ascii')), 'unknown');
});

test('media validation extracts JPEG dimensions from a bounded metadata prefix', () => {
  const jpeg = Uint8Array.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x58, 0x03, 0x20,
  ]);
  assert.deepEqual(detectImageDimensions(jpeg), { width: 800, height: 600 });
  assert.equal(detectImageDimensions(jpeg.subarray(0, 12)), undefined);
});

test('DNS pinning returns the Node-required array shape when lookup requests all results', () => {
  let result: unknown;
  let family: number | undefined;
  returnPinnedLookup('93.184.216.34', true, (_error, value, returnedFamily) => { result = value; family = returnedFamily; });
  assert.deepEqual(result, [{ address: '93.184.216.34', family: 4 }]);
  assert.equal(family, undefined);
  returnPinnedLookup('93.184.216.34', false, (_error, value, returnedFamily) => { result = value; family = returnedFamily; });
  assert.equal(result, '93.184.216.34');
  assert.equal(family, 4);
});

test('media policy rejects adversarial IPv4 and IPv6 destination forms', async () => {
  const publicResolver = async () => ['93.184.216.34'];
  for (const address of [
    '0.0.0.0', '10.255.255.255', '100.64.0.1', '127.255.255.255', '169.254.169.254', '172.31.255.255',
    '192.0.0.1', '192.168.255.255', '198.18.0.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fdff::1', 'fe80::1', 'ff02::1', '2001:db8::1',
  ]) assert.equal(isProhibitedNetworkAddress(address), true, address);
  for (const raw of [
    'https://2130706433/secret', 'https://0x7f000001/secret', 'https://[::1]/secret',
    'https://user:password@example.com/media', 'https://example.com:8443/media',
  ]) await assert.rejects(validatePublicMediaUrl(raw, publicResolver), /(prohibited|credentials|standard HTTPS port)/, raw);
  await assert.rejects(validatePublicMediaUrl('https://mixed.example/media', async () => ['93.184.216.34', '10.0.0.1']), /prohibited/);
});

test('same-host DNS rebinding after a redirect is re-resolved and blocked', async () => {
  let resolutions = 0;
  let requests = 0;
  const result = await probeMediaUrl('https://rebind.example/start', {
    resolver: async () => (++resolutions === 1 ? ['93.184.216.34'] : ['127.0.0.1']),
    requester: async (_url, address) => {
      requests++;
      assert.equal(address, '93.184.216.34');
      return { status: 302, location: '/second' };
    },
  });
  assert.equal(result.outcome, 'unsafe');
  assert.equal(resolutions, 2);
  assert.equal(requests, 1);
});

function luminance(hex: string): number {
  const channels = hex.match(/[0-9a-f]{2}/gi)!.map((part) => Number.parseInt(part, 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

const contrast = (a: string, b: string): number => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
};

test('page shell provides keyboard landmarks, focus visibility, contact, and AA text contrast', () => {
  const html = renderPage('Test', '<h1>Test</h1><label for="field">Field</label><input id="field">', config());
  assert.match(html, /<html lang="en">/);
  assert.match(html, /href="#main">Skip to main content/);
  assert.match(html, /<nav aria-label="Primary">/);
  assert.match(html, /<main id="main" class="shell">/);
  assert.match(html, /:focus-visible/);
  assert.match(html, /summary:focus-visible/);
  assert.match(html, /@media\(forced-colors:active\)/);
  assert.match(html, /outline:3px solid Highlight/);
  assert.match(html, /summary\{display:inline-flex;align-items:center;min-height:2\.75rem/);
  assert.match(html, /support@example\.test/);
  assert.doesNotMatch(html, /tabindex="[1-9]/);
  assert.ok(contrast('#172019', '#fbfaf7') >= 4.5);
  assert.ok(contrast('#5d685f', '#fbfaf7') >= 4.5);
  assert.ok(contrast('#ffffff', '#172019') >= 4.5);
  assert.ok(contrast('#1e5d86', '#fbfaf7') >= 4.5);
  assert.ok(contrast('#8a5500', '#fff3d6') >= 4.5);
  assert.ok(contrast('#a1322c', '#fbe9e6') >= 4.5);
  assert.ok(contrast('#17643b', '#e7f3e9') >= 4.5);
  assert.ok(contrast('#1c6aa0', '#fbfaf7') >= 3);
});

test('production forms expose labels and native keyboard controls without image-alt gaps', () => {
  const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.match(source, /label for=\"affected-position\"/);
  assert.match(source, /label for=\"replacement-url\"/);
  assert.match(source, /label for=\"disconnect-confirmation\"/);
  assert.match(source, /label for=\"delete-confirmation\"/);
  assert.match(source, /label for=\"confirmation\"[\s\S]*?<input id=\"confirmation\" name=\"confirmation\"/);
  assert.doesNotMatch(source, /tabindex=\"[1-9]/);
  assert.doesNotMatch(source, /<div[^>]+onclick=/i);
  assert.doesNotMatch(source, /<img\b/i);
  assert.match(source, /strict-transport-security/);
  assert.match(source, /cross-origin-opener-policy/);
  assert.match(source, /x-frame-options/);
});

test('legal drafts match implemented data practices and avoid paid or certification claims', () => {
  const cfg = config();
  const privacy = privacyNotice(cfg);
  const terms = termsOfService(cfg);
  assert.match(privacy, /no analytics, advertising trackers, marketing email, payment processing/);
  assert.match(privacy, /two first-party, strictly necessary cookies/);
  assert.match(privacy, /seven days without a valid browser session/);
  assert.match(terms, /no fee, subscription, refund/);
  assert.match(terms, /does not guarantee publication/);
  assert.doesNotMatch(`${privacy}${terms}`, /legally compliant|certified compliant/i);
});
