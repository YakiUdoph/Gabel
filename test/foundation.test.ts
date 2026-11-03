import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { beginOAuth, consumeOAuth } from '../src/oauth.ts';
import { BufferClient, BufferError, graphqlOperationName, POST_LIST_QUERY, safeBufferErrorDiagnostic } from '../src/buffer.ts';
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

test('OAuth state is one-time and rejects mismatches', () => {
  const { store, session } = setup();
  const cfg = config();
  const flow = beginOAuth(store, cfg, session);
  assert.equal(consumeOAuth(store, cfg, session, 'wrong'), undefined);
  assert.equal(consumeOAuth(store, cfg, session, flow.state), flow.verifier);
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

test('OAuth state expires and concurrent starts retain only the latest attempt', () => {
  const { store, session } = setup();
  const cfg = config();
  const first = beginOAuth(store, cfg, session);
  const second = beginOAuth(store, cfg, session);
  assert.equal(consumeOAuth(store, cfg, session, first.state), undefined);
  assert.equal(consumeOAuth(store, cfg, session, second.state), second.verifier);
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
    assert.equal(consumeOAuth(store, cfg, session, flow.state), flow.verifier);
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
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

  const edits = new EditService(harness.store, harness.fake, { probe: async () => successfulImageProbe() });
  const intentId = await edits.prepare(harness.tenant, 'connection', harness.before.id, replacements);
  const row = harness.store.db.prepare('SELECT intended_assets_json,outcome_json FROM edit_intents WHERE id=?').get(intentId) as Record<string, string>;
  assert.equal((JSON.parse(row.intended_assets_json)[0] as { image: { thumbnailUrl?: string } }).image.thumbnailUrl, undefined);
  assert.equal((JSON.parse(row.outcome_json) as { replacementValidations: unknown[] }).replacementValidations.length, 1);
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

test('a network exception during mutation is classified as ambiguous', () => {
  assert.equal(classifyMutationException(new BufferError('lost response', 'network')), 'ambiguous');
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
  for (const table of ['tenants', 'browser_sessions', 'buffer_connections', 'organizations', 'channels', 'posts', 'assets', 'edit_intents', 'evidence_events']) {
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
  assert.match(html, /<main id="main">/);
  assert.match(html, /:focus-visible/);
  assert.match(html, /support@example\.test/);
  assert.doesNotMatch(html, /tabindex="[1-9]/);
  assert.ok(contrast('#17202a', '#ffffff') >= 4.5);
  assert.ok(contrast('#45515d', '#ffffff') >= 4.5);
  assert.ok(contrast('#ffffff', '#17202a') >= 4.5);
  assert.ok(contrast('#0050a4', '#ffffff') >= 4.5);
  assert.ok(contrast('#17202a', '#fff5d6') >= 4.5);
  assert.ok(contrast('#17202a', '#ffe5e5') >= 4.5);
  assert.ok(contrast('#17202a', '#e3f7e8') >= 4.5);
  assert.ok(contrast('#005fcc', '#ffffff') >= 3);
});

test('production forms expose labels and native keyboard controls without image-alt gaps', () => {
  const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.match(source, /label for=\"replacements-\$\{index\}\"/);
  assert.match(source, /label for=\"disconnect-confirmation\"/);
  assert.match(source, /label for=\"delete-confirmation\"/);
  assert.match(source, /<label>Type <code>EDIT POST[\s\S]*?<input name=\"confirmation\"/);
  assert.doesNotMatch(source, /tabindex=\"[1-9]/);
  assert.doesNotMatch(source, /<div[^>]+onclick=/i);
  assert.doesNotMatch(source, /<img\b/i);
});

test('legal drafts match implemented data practices and avoid paid or certification claims', () => {
  const cfg = config();
  const privacy = privacyNotice(cfg);
  const terms = termsOfService(cfg);
  assert.match(privacy, /no analytics, advertising trackers, marketing email, payment processing/);
  assert.match(privacy, /two first-party, strictly necessary cookies/);
  assert.match(terms, /no fee, subscription, refund/);
  assert.match(terms, /does not guarantee publication/);
  assert.doesNotMatch(`${privacy}${terms}`, /legally compliant|certified compliant/i);
});
