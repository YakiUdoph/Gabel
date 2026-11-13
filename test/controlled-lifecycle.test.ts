import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';

import { BufferClient, BufferError } from '../src/buffer.ts';
import { ControlledPostCreationAmbiguousError, ControlledTestPostService, controlledTestText, createConfirmation,
  deleteConfirmation, openControlledReceipt, sealControlledReceipt, type ControlledTestPostReceipt,
  type ControlledTestPostSpec } from '../src/controlled-test-post.ts';
import { Store } from '../src/db.ts';
import type { BufferPost } from '../src/types.ts';
import type { MediaProbeResult } from '../src/media-security.ts';

const now = Date.parse('2026-11-03T12:00:00.000Z');

function fixture() {
  const store = new Store(':memory:');
  const tenantId = randomUUID();
  store.createTenant(tenantId);
  store.upsertConnection({ id: 'connection', tenant_id: tenantId, buffer_account_id: 'account', access_token_ciphertext: 'unused',
    refresh_token_ciphertext: null, access_expires_at: new Date(now + 86_400_000).toISOString(), scopes: 'posts:read posts:write' });
  const spec: ControlledTestPostSpec = { runId: 'run-12345678', tenantId, connectionId: 'connection', channelId: 'channel-1',
    dueAt: '2026-11-07T12:00:00.000Z', originalUrl: 'https://media.example/original' };
  const post: BufferPost = { id: 'controlled-post', channelId: spec.channelId, status: 'scheduled', dueAt: spec.dueAt,
    shareMode: 'customScheduled', schedulingType: 'automatic', text: controlledTestText(spec.runId), updatedAt: new Date(now).toISOString(),
    allowedActions: ['updatePost', 'deletePost'], metadata: { type: 'post' }, tags: [], assets: [{ id: 'asset', type: 'image',
      mimeType: 'image/png', source: spec.originalUrl, thumbnail: '', image: { altText: 'Disposable Gabel controlled repair test image',
        animatedThumbnail: null, userTags: null } }] };
  const probe: MediaProbeResult = { outcome: 'reachable', httpStatus: 200, contentType: 'image/png', declaredFormat: 'png', detectedFormat: 'png',
    fileSizeBytes: 1_000_000, dimensions: { width: 1536, height: 1024 }, inspectionDigest: 'digest', dnsLookups: 1,
    resolvedAddressCount: 1, addressFamilies: [4], allAddressesPublic: true, redirects: 0, reason: 'ready', durationMs: 1 };
  return { store, spec, post, probe };
}

test('controlled lifecycle creates only the fixed disposable post after exact approval', async () => {
  const { store, spec, post, probe } = fixture();
  let mutationInput: Record<string, unknown> | undefined;
  const fake = {
    discover: async () => ({ organizations: [{ id: 'org', name: 'Org', channels: [{ id: spec.channelId, service: 'twitter', isDisconnected: false, isLocked: false }] }], posts: [] }),
    graphql: async (_tenant: string, _connection: string, query: string, variables: { input: Record<string, unknown> }) => {
      assert.match(query, /GabelCreateControlledTestPost/);
      mutationInput = variables.input;
      return { data: { createPost: { post } }, requestId: 'create-request' };
    },
    getPost: async () => ({ post }),
  } as unknown as BufferClient;
  const service = new ControlledTestPostService(store, fake, async () => probe, () => now);
  await assert.rejects(service.create(spec, 'yes'), /exactly match/);
  const result = await service.create(spec, createConfirmation(spec.runId));
  assert.equal(result.receipt.postId, post.id);
  assert.deepEqual(mutationInput, {
    channelId: spec.channelId, text: controlledTestText(spec.runId), schedulingType: 'automatic', mode: 'customScheduled', dueAt: spec.dueAt,
    needsApproval: false, saveToDraft: false,
    assets: [{ image: { url: spec.originalUrl, metadata: { altText: 'Disposable Gabel controlled repair test image' } } }],
  });
  store.close();
});

test('controlled lifecycle preserves a cleanup receipt when creation verification is ambiguous', async () => {
  const { store, spec, post, probe } = fixture();
  const fake = {
    discover: async () => ({ organizations: [{ id: 'org', name: 'Org', channels: [{ id: spec.channelId, service: 'twitter' }] }], posts: [] }),
    graphql: async () => ({ data: { createPost: { post } } }),
    getPost: async () => { throw new BufferError('verification unavailable', 'network'); },
  } as unknown as BufferClient;
  const service = new ControlledTestPostService(store, fake, async () => probe, () => now);
  await assert.rejects(service.create(spec, createConfirmation(spec.runId)), (error: ControlledPostCreationAmbiguousError) => {
    assert.equal(error.receipt.postId, post.id);
    return true;
  });
  store.close();
});

test('controlled lifecycle deletion is receipt-bound, freshly verified, capability-gated, and exact', async () => {
  const { store, spec, post } = fixture();
  const receipt: ControlledTestPostReceipt = { ...spec, postId: post.id, text: post.text, createdAt: new Date(now).toISOString() };
  let deletedId: string | undefined;
  const fake = {
    getPost: async () => ({ post }),
    graphql: async (_tenant: string, _connection: string, query: string, variables: { input: { id: string } }) => {
      assert.match(query, /GabelDeleteControlledTestPost/);
      deletedId = variables.input.id;
      return { data: { deletePost: { id: variables.input.id } }, requestId: 'delete-request' };
    },
  } as unknown as BufferClient;
  const service = new ControlledTestPostService(store, fake, undefined, () => now);
  await assert.rejects(service.delete(receipt, 'delete it'), /exactly match/);
  const result = await service.delete(receipt, deleteConfirmation(post.id));
  assert.equal(result.id, post.id);
  assert.equal(deletedId, post.id);
  store.close();
});

test('controlled cleanup accepts only the original or uniquely verified repaired disposable state', async () => {
  const { store, spec, post } = fixture();
  const receipt: ControlledTestPostReceipt = { ...spec, postId: post.id, text: post.text, createdAt: new Date(now).toISOString() };
  const replacementUrl = 'https://media.example/replacement';
  const repaired: BufferPost = { ...post, updatedAt: new Date(now + 1_000).toISOString(), assets: [{ ...post.assets[0], source: replacementUrl }] };
  const intended = [{ image: { url: replacementUrl, metadata: { altText: 'Disposable Gabel controlled repair test image' } } }];
  store.db.prepare(`INSERT INTO edit_intents(id,tenant_id,connection_id,post_id,before_json,intended_assets_json,before_fingerprint,status,created_at,expires_at,outcome_json)
    VALUES(?,?,?,?,?,?,?,'confirmed',?,?,?)`).run('verified-repair', spec.tenantId, spec.connectionId, post.id, JSON.stringify(post),
      JSON.stringify(intended), 'before-fingerprint', new Date(now).toISOString(), new Date(now + 600_000).toISOString(),
      JSON.stringify({ comparison: { matches: true, discrepancies: [] } }));
  store.db.prepare(`INSERT INTO edit_intent_claims(intent_id,tenant_id,claim_id,state,claimed_at,expires_at,mutation_started_at,completed_at)
    VALUES(?,?,?,'completed',?,?,?,?)`).run('verified-repair', spec.tenantId, 'verified-claim', new Date(now).toISOString(),
      new Date(now + 600_000).toISOString(), new Date(now).toISOString(), new Date(now).toISOString());

  let current = post;
  let deletions = 0;
  const fake = {
    getPost: async () => ({ post: current }),
    graphql: async (_tenant: string, _connection: string, _query: string, variables: { input: { id: string } }) => {
      deletions += 1;
      return { data: { deletePost: { id: variables.input.id } } };
    },
  } as unknown as BufferClient;
  const service = new ControlledTestPostService(store, fake, undefined, () => now);

  await service.delete(receipt, deleteConfirmation(post.id));
  current = repaired;
  await service.delete(receipt, deleteConfirmation(post.id));
  assert.equal(deletions, 2);

  const rejected: Array<[string, BufferPost]> = [
    ['identity', { ...repaired, id: 'unrelated-post' }],
    ['channel', { ...repaired, channelId: 'other-channel' }],
    ['scheduled time', { ...repaired, dueAt: '2026-11-08T12:00:00.000Z' }],
    ['text', { ...repaired, text: 'altered text' }],
    ['media', { ...repaired, assets: [{ ...repaired.assets[0], source: 'https://media.example/unapproved' }] }],
  ];
  for (const [label, changed] of rejected) {
    current = changed;
    await assert.rejects(service.delete(receipt, deleteConfirmation(post.id)), (error: Error) => {
      assert.ok(error.message.length > 0, label);
      return true;
    });
  }
  assert.equal(deletions, 2);
  await assert.rejects(service.delete(receipt, 'DELETE CONTROLLED TEST POST wrong-id'), /exactly match/);
  assert.equal(deletions, 2);
  store.close();
});

test('controlled lifecycle refuses deletion when the exact post no longer matches the receipt', async () => {
  const { store, spec, post } = fixture();
  const receipt: ControlledTestPostReceipt = { ...spec, postId: post.id, text: post.text, createdAt: new Date(now).toISOString() };
  let mutationSent = false;
  const fake = { getPost: async () => ({ post: { ...post, text: 'different content' } }), graphql: async () => { mutationSent = true; } } as unknown as BufferClient;
  const service = new ControlledTestPostService(store, fake, undefined, () => now);
  await assert.rejects(service.delete(receipt, deleteConfirmation(post.id)), /text changed/);
  assert.equal(mutationSent, false);
  store.close();
});

test('controlled lifecycle receipts reject tampering', () => {
  const { store, spec, post } = fixture();
  const receipt: ControlledTestPostReceipt = { ...spec, postId: post.id, text: post.text, createdAt: new Date(now).toISOString() };
  const secret = randomBytes(32);
  const sealed = sealControlledReceipt(receipt, secret);
  assert.deepEqual(openControlledReceipt(sealed, secret), receipt);
  assert.throws(() => openControlledReceipt(`${sealed.slice(0, -1)}x`, secret), /signature/);
  store.close();
});
