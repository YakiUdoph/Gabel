import { createHash, randomUUID } from 'node:crypto';
import type { Store } from './db.ts';
import type { AssetInput, BufferAsset, BufferPost } from './types.ts';
import { BufferClient, BufferError, POST_FIELDS } from './buffer.ts';
import { evidencePost, sanitize } from './security.ts';
import { probeMediaUrl } from './media-security.ts';
import { assertFreshMatchingValidation, ReplacementValidationError, validateImageReplacements,
  type ReplacementValidationEvidence } from './replacement-validation.ts';

export const fingerprintPost = (post: BufferPost): string => createHash('sha256').update(JSON.stringify({
  id: post.id, channelId: post.channelId, status: post.status, dueAt: post.dueAt, shareMode: post.shareMode,
  schedulingType: post.schedulingType, text: post.text, updatedAt: post.updatedAt, allowedActions: post.allowedActions,
  metadata: post.metadata, tags: post.tags, assets: post.assets,
})).digest('base64url');

function optional<T>(value: T | null | undefined): T | undefined { return value == null ? undefined : value; }

export function assetToInput(asset: BufferAsset, replacementUrl = asset.source): AssetInput {
  if (!replacementUrl.startsWith('https://')) throw new Error('Every replacement must be a direct HTTPS URL');
  const replaced = replacementUrl !== asset.source;
  if (asset.type === 'image' && asset.image) {
    return { image: {
      url: replacementUrl,
      thumbnailUrl: replaced ? undefined : asset.thumbnail || undefined,
      metadata: {
        altText: asset.image.altText,
        animatedThumbnail: optional(asset.image.animatedThumbnail),
        userTags: optional(asset.image.userTags ?? undefined),
      },
    }};
  }
  if (asset.type === 'video' && asset.video) {
    return { video: { url: replacementUrl, metadata: {
      thumbnailOffset: optional(asset.video.thumbnailOffset), title: optional(asset.video.title),
    }}};
  }
  if (asset.type === 'document' && asset.document?.title && asset.thumbnail) {
    return { document: { url: replacementUrl, thumbnailUrl: asset.thumbnail, title: asset.document.title } };
  }
  throw new Error(`Asset ${asset.id ?? '(no id)'} of type ${asset.type} cannot be losslessly reconstructed from documented fields`);
}

export function buildCompleteAssetList(post: BufferPost, replacements: Map<number, string>): AssetInput[] {
  if (!post.assets.length) throw new Error('This post has no media assets');
  for (const position of replacements.keys()) if (!Number.isInteger(position) || position < 0 || position >= post.assets.length) {
    throw new Error(`Replacement position ${position} is outside the asset list`);
  }
  return post.assets.map((asset, index) => assetToInput(asset, replacements.get(index)));
}

export function assertPostEditable(post: BufferPost): void {
  if (post.status !== 'scheduled') throw new Error(`Only scheduled posts may be tested; current status is ${post.status}`);
  if (!post.allowedActions.includes('updatePost')) throw new Error('Buffer does not currently authorize this post to be updated');
}

export type Comparison = { matches: boolean; discrepancies: string[] };
export const classifyMutationException = (error: unknown): 'ambiguous' | 'failure' =>
  error instanceof BufferError && ['network', 'graphql', 'http', 'invalid_response'].includes(error.kind) ? 'ambiguous' : 'failure';

export function comparePost(before: BufferPost, after: BufferPost, intendedAssets: AssetInput[]): Comparison {
  const discrepancies: string[] = [];
  if (before.dueAt !== after.dueAt) discrepancies.push(`dueAt changed from ${before.dueAt} to ${after.dueAt}`);
  if (before.shareMode !== after.shareMode) discrepancies.push(`shareMode changed from ${before.shareMode} to ${after.shareMode}`);
  if (before.schedulingType !== after.schedulingType) discrepancies.push(`schedulingType changed from ${before.schedulingType} to ${after.schedulingType}`);
  if (before.text !== after.text) discrepancies.push('post text changed');
  if (before.channelId !== after.channelId) discrepancies.push('channel changed');
  if (JSON.stringify(before.metadata) !== JSON.stringify(after.metadata)) discrepancies.push('post metadata changed');
  if (JSON.stringify(before.tags) !== JSON.stringify(after.tags)) discrepancies.push('post tags changed');
  const actual = after.assets.map((asset, index) => {
    const reconstructed = assetToInput(asset);
    const intended = intendedAssets[index];
    if (intended && 'image' in intended && intended.image.thumbnailUrl === undefined && 'image' in reconstructed) {
      reconstructed.image.thumbnailUrl = undefined;
    }
    return reconstructed;
  });
  if (JSON.stringify(actual) !== JSON.stringify(intendedAssets)) discrepancies.push('actual asset list differs from intended asset list');
  return { matches: discrepancies.length === 0, discrepancies };
}

export class EditService {
  readonly store: Store;
  readonly buffer: BufferClient;
  readonly probe: typeof probeMediaUrl;
  readonly now: () => number;

  constructor(store: Store, buffer: BufferClient, options: { probe?: typeof probeMediaUrl; now?: () => number } = {}) {
    this.store = store;
    this.buffer = buffer;
    this.probe = options.probe ?? probeMediaUrl;
    this.now = options.now ?? Date.now;
  }

  async prepare(tenantId: string, connectionId: string, postId: string, replacements: Map<number, string>): Promise<string> {
    const { post } = await this.buffer.getPost(tenantId, connectionId, postId);
    assertPostEditable(post);
    const assets = buildCompleteAssetList(post, replacements);
    const now = this.now();
    const validations = await validateImageReplacements({ store: this.store, buffer: this.buffer, tenantId, connectionId,
      post, replacements, probe: this.probe, now });
    const id = randomUUID();
    this.store.db.prepare(`INSERT INTO edit_intents(id,tenant_id,connection_id,post_id,before_json,intended_assets_json,before_fingerprint,status,created_at,expires_at)
      VALUES(?,?,?,?,?,?,?,'pending',?,?)`).run(id, tenantId, connectionId, postId, JSON.stringify(post), JSON.stringify(assets),
        fingerprintPost(post), new Date(now).toISOString(), new Date(now + 10 * 60_000).toISOString());
    this.store.db.prepare('UPDATE edit_intents SET outcome_json=? WHERE id=?').run(JSON.stringify({ replacementValidations: validations }), id);
    return id;
  }

  async confirm(tenantId: string, intentId: string, confirmation: string): Promise<Comparison> {
    const intent = this.store.db.prepare(`SELECT * FROM edit_intents WHERE id=? AND tenant_id=? AND status='pending' AND expires_at>?`)
      .get(intentId, tenantId, new Date().toISOString()) as Record<string, string> | undefined;
    if (!intent) throw new Error('Edit intent is missing, expired, already used, or belongs to another tenant');
    if (confirmation !== `EDIT POST ${intent.post_id}`) throw new Error(`Confirmation must exactly match EDIT POST ${intent.post_id}`);
    const latest = await this.buffer.getPost(tenantId, intent.connection_id, intent.post_id);
    if (fingerprintPost(latest.post) !== intent.before_fingerprint) {
      this.store.db.prepare(`UPDATE edit_intents SET status='aborted_stale', outcome_json=? WHERE id=?`)
        .run(JSON.stringify({ reason: 'Post changed after preparation' }), intentId);
      this.store.addEvidence({ id: randomUUID(), tenantId, operation: 'edit_post', outcome: 'failure', sanitized: { reason: 'post_changed_before_mutation', postFingerprint: fingerprintPost(latest.post) } });
      throw new Error('Post changed after preparation; no mutation was sent');
    }
    const intendedAssets = JSON.parse(intent.intended_assets_json) as AssetInput[];
    const previousValidations = ((JSON.parse(intent.outcome_json ?? '{}') as { replacementValidations?: ReplacementValidationEvidence[] })
      .replacementValidations ?? []);
    const replacements = new Map<number, string>(previousValidations.map((validation) => {
      const intended = intendedAssets[validation.position];
      if (!intended || !('image' in intended)) throw new ReplacementValidationError('The replacement preview is invalid. No mutation was sent.');
      return [validation.position, intended.image.url];
    }));
    try {
      const currentValidations = await validateImageReplacements({ store: this.store, buffer: this.buffer, tenantId,
        connectionId: intent.connection_id, post: latest.post, replacements, probe: this.probe, now: this.now() });
      assertFreshMatchingValidation(previousValidations, currentValidations, this.now());
    } catch (error) {
      this.store.db.prepare(`UPDATE edit_intents SET status='aborted_stale', outcome_json=? WHERE id=?`)
        .run(JSON.stringify({ reason: error instanceof Error ? error.message : 'Replacement validation failed' }), intentId);
      throw error;
    }
    let mutationData: { editPost: { post?: BufferPost; message?: string } };
    let requestId: string | undefined;
    try {
      const result = await this.buffer.graphql<typeof mutationData>(tenantId, intent.connection_id, `
        mutation GabelEditPost($input: EditPostInput!) {
          editPost(input: $input) {
            ... on PostActionSuccess { post { ${POST_FIELDS} } }
            ... on MutationError { message }
          }
        }`, { input: { id: intent.post_id, assets: intendedAssets } });
      mutationData = result.data;
      requestId = result.requestId;
    } catch (error) {
      const classification = classifyMutationException(error);
      const ambiguous = classification === 'ambiguous';
      this.store.db.prepare(`UPDATE edit_intents SET status=?, outcome_json=? WHERE id=?`)
        .run(ambiguous ? 'ambiguous' : 'failed', JSON.stringify(sanitize(error)), intentId);
      this.store.addEvidence({ id: randomUUID(), tenantId, operation: 'edit_post', outcome: ambiguous ? 'ambiguous' : 'failure', sanitized: sanitize(error) });
      throw error;
    }
    if (!mutationData.editPost.post) {
      this.store.db.prepare(`UPDATE edit_intents SET status='failed', outcome_json=? WHERE id=?`)
        .run(JSON.stringify(sanitize(mutationData)), intentId);
      this.store.addEvidence({ id: randomUUID(), tenantId, operation: 'edit_post', outcome: 'failure', requestId,
        sanitized: { typedMutationError: mutationData.editPost.message ?? 'unknown' } });
      throw new Error('Buffer rejected the edit; no success was recorded');
    }
    let after: BufferPost;
    try {
      after = (await this.buffer.getPost(tenantId, intent.connection_id, intent.post_id)).post;
    } catch (error) {
      this.store.db.prepare(`UPDATE edit_intents SET status='ambiguous', outcome_json=? WHERE id=?`)
        .run(JSON.stringify({ mutationResponse: sanitize(mutationData), refetchError: sanitize(error) }), intentId);
      this.store.addEvidence({ id: randomUUID(), tenantId, operation: 'edit_post', outcome: 'ambiguous', requestId,
        sanitized: { reason: 'mutation_succeeded_but_verification_retrieval_failed' } });
      throw new BufferError('Edit returned success but verification retrieval failed; outcome is ambiguous', 'network', sanitize(error), requestId);
    }
    const before = JSON.parse(intent.before_json) as BufferPost;
    const comparison = comparePost(before, after, intendedAssets);
    const status = comparison.matches ? 'confirmed' : 'ambiguous';
    const outcome = { before: evidencePost(before), after: evidencePost(after), comparison };
    this.store.db.prepare(`UPDATE edit_intents SET status=?, outcome_json=? WHERE id=?`).run(status, JSON.stringify(outcome), intentId);
    this.store.addEvidence({ id: randomUUID(), tenantId, operation: 'edit_post', outcome: comparison.matches ? 'success' : 'ambiguous', requestId, sanitized: outcome });
    return comparison;
  }
}
