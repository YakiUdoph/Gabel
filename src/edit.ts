import { createHash, randomUUID } from 'node:crypto';
import type { AppStore } from './persistence.ts';
import type { AssetInput, BufferAsset, BufferPost } from './types.ts';
import { BufferClient, BufferError, POST_FIELDS } from './buffer.ts';
import { evidencePost, sanitize } from './security.ts';
import { probeMediaUrl } from './media-security.ts';
import { assertFreshMatchingValidation, ReplacementValidationError, validateImageReplacements,
  type ReplacementValidationEvidence } from './replacement-validation.ts';
import { PublicError } from './errors.ts';

export const fingerprintPost = (post: BufferPost): string => createHash('sha256').update(JSON.stringify({
  id: post.id, channelId: post.channelId, status: post.status, dueAt: post.dueAt, shareMode: post.shareMode,
  schedulingType: post.schedulingType, text: post.text, updatedAt: post.updatedAt, allowedActions: post.allowedActions,
  metadata: post.metadata, tags: post.tags, assets: post.assets,
})).digest('base64url');

function optional<T>(value: T | null | undefined): T | undefined { return value == null ? undefined : value; }

export function assetToInput(asset: BufferAsset, replacementUrl = asset.source): AssetInput {
  if (!replacementUrl.startsWith('https://')) throw new PublicError('Every replacement must be a direct HTTPS URL');
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
  throw new PublicError(`Asset ${asset.id ?? '(no id)'} of type ${asset.type} cannot be losslessly reconstructed from documented fields`);
}

export function buildCompleteAssetList(post: BufferPost, replacements: Map<number, string>): AssetInput[] {
  if (!post.assets.length) throw new PublicError('This post has no media assets');
  for (const position of replacements.keys()) if (!Number.isInteger(position) || position < 0 || position >= post.assets.length) {
    throw new PublicError(`Replacement position ${position} is outside the asset list`);
  }
  return post.assets.map((asset, index) => assetToInput(asset, replacements.get(index)));
}

export function assertPostEditable(post: BufferPost): void {
  if (post.status !== 'scheduled') throw new PublicError(`Only scheduled posts may be tested; current status is ${post.status}`);
  if (!post.allowedActions.includes('updatePost')) throw new PublicError('Buffer does not currently authorize this post to be updated');
}

export type Comparison = { matches: boolean; discrepancies: string[] };
export const BUFFER_POST_STATUSES = new Set(['draft', 'error', 'needs_approval', 'scheduled', 'sending', 'sent']);
export const classifyMutationException = (error: unknown): 'ambiguous' | 'failure' =>
  error instanceof BufferError && ['network', 'timeout', 'graphql', 'http', 'invalid_response'].includes(error.kind) ? 'ambiguous' : 'failure';

function comparablePostIssues(value: BufferPost, label: 'original' | 'fresh'): string[] {
  const issues: string[] = [];
  if (typeof value.id !== 'string' || value.id.length === 0) issues.push(`${label} post identity is missing`);
  if (typeof value.channelId !== 'string' || value.channelId.length === 0) issues.push(`${label} channel is missing`);
  if (typeof value.status !== 'string' || value.status.length === 0) issues.push(`${label} post status is missing`);
  else if (!BUFFER_POST_STATUSES.has(value.status)) issues.push(`${label} post status is unknown`);
  if (typeof value.text !== 'string') issues.push(`${label} post text is missing`);
  if (typeof value.shareMode !== 'string' || value.shareMode.length === 0) issues.push(`${label} share mode is missing`);
  if (!Array.isArray(value.tags)) issues.push(`${label} post tags are missing`);
  if (!Array.isArray(value.assets)) issues.push(`${label} post assets are missing`);
  return issues;
}

export function comparePost(before: BufferPost, after: BufferPost | null | undefined, intendedAssets: AssetInput[]): Comparison {
  const discrepancies: string[] = [];
  discrepancies.push(...comparablePostIssues(before, 'original'));
  if (!after || typeof after !== 'object') return { matches: false, discrepancies: [...discrepancies, 'fresh post verification response is missing'] };
  discrepancies.push(...comparablePostIssues(after, 'fresh'));
  if (before.id !== after.id) discrepancies.push('post identity changed');
  if (before.status !== 'scheduled') discrepancies.push('original post status is not scheduled');
  if (after.status !== before.status) discrepancies.push('post status changed');
  if (before.dueAt !== after.dueAt) discrepancies.push(`dueAt changed from ${before.dueAt} to ${after.dueAt}`);
  if (before.shareMode !== after.shareMode) discrepancies.push(`shareMode changed from ${before.shareMode} to ${after.shareMode}`);
  if (before.schedulingType !== after.schedulingType) discrepancies.push(`schedulingType changed from ${before.schedulingType} to ${after.schedulingType}`);
  if (before.text !== after.text) discrepancies.push('post text changed');
  if (before.channelId !== after.channelId) discrepancies.push('channel changed');
  if (JSON.stringify(before.metadata) !== JSON.stringify(after.metadata)) discrepancies.push('post metadata changed');
  if (JSON.stringify(before.tags) !== JSON.stringify(after.tags)) discrepancies.push('post tags changed');
  const actual = Array.isArray(after.assets) ? after.assets.map((asset, index) => {
    const reconstructed = assetToInput(asset);
    const intended = intendedAssets[index];
    if (intended && 'image' in intended && intended.image.thumbnailUrl === undefined && 'image' in reconstructed) {
      reconstructed.image.thumbnailUrl = undefined;
    }
    return reconstructed;
  }) : undefined;
  if (JSON.stringify(actual) !== JSON.stringify(intendedAssets)) discrepancies.push('actual asset list differs from intended asset list');
  return { matches: discrepancies.length === 0, discrepancies };
}

export class EditService {
  readonly store: AppStore;
  readonly buffer: BufferClient;
  readonly probe: typeof probeMediaUrl;
  readonly now: () => number;

  constructor(store: AppStore, buffer: BufferClient, options: { probe?: typeof probeMediaUrl; now?: () => number } = {}) {
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
    const problemEvidence = await this.store.getFreshConfirmedProblemEvidence(tenantId, connectionId, postId, new Date(now));
    const id = randomUUID();
    await this.store.createEditIntent({ id, tenantId, connectionId, postId, beforeJson: JSON.stringify(post), intendedAssetsJson: JSON.stringify(assets),
      beforeFingerprint: fingerprintPost(post), createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 10 * 60_000).toISOString(),
      outcomeJson: JSON.stringify({ replacementValidations: validations, problemEvidence }) });
    return id;
  }

  async confirm(tenantId: string, intentId: string, confirmation: string): Promise<Comparison> {
    const preview = await this.store.getPendingEditIntent(tenantId, intentId);
    if (!preview) throw new PublicError('Edit intent is missing, expired, already used, or belongs to another tenant');
    if (confirmation !== `EDIT POST ${preview.post_id}`) throw new PublicError(`Confirmation must exactly match EDIT POST ${preview.post_id}`);
    const claimId = randomUUID();
    const intent = await this.store.claimEditIntent(tenantId, intentId, preview.post_id, claimId);
    if (!intent) throw new PublicError('Edit intent is already claimed, expired, used, or belongs to another tenant; no mutation was sent');
    let latest: { post: BufferPost };
    let intendedAssets: AssetInput[];
    try {
      latest = await this.buffer.getPost(tenantId, intent.connection_id, intent.post_id);
      if (fingerprintPost(latest.post) !== intent.before_fingerprint) {
        await this.store.updateEditIntent(intentId, 'aborted_stale', { reason: 'Post changed after preparation' }, true);
        await this.store.addEvidence({ id: randomUUID(), tenantId, operation: 'edit_post', outcome: 'failure', sanitized: { reason: 'post_changed_before_mutation', postFingerprint: fingerprintPost(latest.post) } });
        throw new PublicError('Post changed after preparation; no mutation was sent');
      }
      intendedAssets = JSON.parse(intent.intended_assets_json) as AssetInput[];
      const previousValidations = ((JSON.parse(intent.outcome_json ?? '{}') as { replacementValidations?: ReplacementValidationEvidence[] })
        .replacementValidations ?? []);
      const replacements = new Map<number, string>(previousValidations.map((validation) => {
        const intended = intendedAssets[validation.position];
        if (!intended || !('image' in intended)) throw new ReplacementValidationError('The replacement preview is invalid. No mutation was sent.');
        return [validation.position, intended.image.url];
      }));
      const currentValidations = await validateImageReplacements({ store: this.store, buffer: this.buffer, tenantId,
        connectionId: intent.connection_id, post: latest.post, replacements, probe: this.probe, now: this.now() });
      assertFreshMatchingValidation(previousValidations, currentValidations, this.now());
    } catch (error) {
      await this.store.updateEditIntent(intentId, 'aborted_stale', { reason: error instanceof Error ? error.message : 'Pre-mutation validation failed' }, true);
      await this.store.finishEditClaim(intentId, claimId, 'failed');
      throw error;
    }
    if (!await this.store.startEditMutation(intentId, claimId)) {
      await this.store.updateEditIntent(intentId, 'aborted_stale', { reason: 'The durable approval claim expired before mutation; no mutation was sent' }, true);
      await this.store.finishEditClaim(intentId, claimId, 'failed');
      throw new PublicError('The approval claim expired before mutation; no mutation was sent. Prepare a new repair intent.');
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
      await this.store.updateEditIntent(intentId, ambiguous ? 'ambiguous' : 'failed', sanitize(error));
      await this.store.finishEditClaim(intentId, claimId, ambiguous ? 'ambiguous' : 'failed');
      await this.store.addEvidence({ id: randomUUID(), tenantId, operation: 'edit_post', outcome: ambiguous ? 'ambiguous' : 'failure', sanitized: sanitize(error) });
      throw error;
    }
    if (!mutationData.editPost.post) {
      await this.store.updateEditIntent(intentId, 'failed', sanitize(mutationData));
      await this.store.finishEditClaim(intentId, claimId, 'failed');
      await this.store.addEvidence({ id: randomUUID(), tenantId, operation: 'edit_post', outcome: 'failure', requestId,
        sanitized: { typedMutationError: mutationData.editPost.message ?? 'unknown' } });
      throw new PublicError('Buffer rejected the edit; no success was recorded');
    }
    let after: BufferPost | undefined;
    try {
      after = (await this.buffer.getPost(tenantId, intent.connection_id, intent.post_id)).post;
    } catch (error) {
      await this.store.updateEditIntent(intentId, 'ambiguous', { mutationResponse: sanitize(mutationData), refetchError: sanitize(error) });
      await this.store.finishEditClaim(intentId, claimId, 'ambiguous');
      await this.store.addEvidence({ id: randomUUID(), tenantId, operation: 'edit_post', outcome: 'ambiguous', requestId,
        sanitized: { reason: 'mutation_succeeded_but_verification_retrieval_failed' } });
      throw new BufferError('Edit returned success but verification retrieval failed; outcome is ambiguous', 'network', sanitize(error), requestId);
    }
    const before = JSON.parse(intent.before_json) as BufferPost;
    const comparison = comparePost(before, after, intendedAssets);
    const status = comparison.matches ? 'confirmed' : 'ambiguous';
    const outcome = { before: evidencePost(before), after: after ? evidencePost(after) : { missing: true }, comparison };
    await this.store.updateEditIntent(intentId, status, outcome);
    await this.store.finishEditClaim(intentId, claimId, comparison.matches ? 'completed' : 'ambiguous');
    await this.store.addEvidence({ id: randomUUID(), tenantId, operation: 'edit_post', outcome: comparison.matches ? 'success' : 'ambiguous', requestId, sanitized: outcome });
    return comparison;
  }
}
