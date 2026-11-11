import { createHmac } from 'node:crypto';
import type { Store } from './db.ts';
import { BufferClient, POST_FIELDS } from './buffer.ts';
import type { BufferPost } from './types.ts';
import { probeMediaUrl, type MediaProbeResult } from './media-security.ts';
import { safeEqual } from './security.ts';

const MINIMUM_LEAD_MS = 72 * 60 * 60_000;
const TEST_COPY_PREFIX = 'DISPOSABLE GABEL CONTROLLED REPAIR TEST — DO NOT PUBLISH';

export type ControlledTestPostSpec = {
  runId: string;
  tenantId: string;
  connectionId: string;
  channelId: string;
  dueAt: string;
  originalUrl: string;
};

export type ControlledTestPostReceipt = ControlledTestPostSpec & {
  postId: string;
  text: string;
  createdAt: string;
};

export class ControlledPostCreationAmbiguousError extends Error {
  readonly receipt: ControlledTestPostReceipt;
  constructor(message: string, receipt: ControlledTestPostReceipt) {
    super(message);
    this.receipt = receipt;
  }
}

type MutationResult = { post?: BufferPost; message?: string };

export const controlledTestText = (runId: string): string => `${TEST_COPY_PREFIX} [${runId}]`;
export const createConfirmation = (runId: string): string => `CREATE CONTROLLED TEST POST ${runId}`;
export const deleteConfirmation = (postId: string): string => `DELETE CONTROLLED TEST POST ${postId}`;

function directPublicUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || (url.port && url.port !== '443')) throw new Error('Controlled media must use standard-port HTTPS');
  if (url.username || url.password || url.search || url.hash) throw new Error('Controlled media URL must not contain credentials, a query, or a fragment');
  return url;
}

export function validateControlledTestSpec(spec: ControlledTestPostSpec, now = Date.now()): void {
  if (!/^[a-z0-9][a-z0-9-]{7,63}$/i.test(spec.runId)) throw new Error('runId must be an 8-64 character alphanumeric/hyphen identifier');
  for (const [name, value] of Object.entries({ tenantId: spec.tenantId, connectionId: spec.connectionId, channelId: spec.channelId })) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  }
  const due = Date.parse(spec.dueAt);
  if (!Number.isFinite(due) || !spec.dueAt.endsWith('Z')) throw new Error('dueAt must be a UTC ISO 8601 timestamp');
  if (due < now + MINIMUM_LEAD_MS) throw new Error('Controlled post must be scheduled at least 72 hours ahead');
  directPublicUrl(spec.originalUrl);
}

function assertProbeReady(result: MediaProbeResult): void {
  if (result.outcome !== 'reachable' || ![200, 206].includes(result.httpStatus ?? 0)) throw new Error('Original controlled image is not currently reachable');
  if (!result.declaredFormat || result.declaredFormat !== result.detectedFormat || !['jpeg', 'png'].includes(result.declaredFormat)) {
    throw new Error('Original controlled image must have matching JPEG or PNG MIME and signature');
  }
  if (!result.fileSizeBytes || result.fileSizeBytes > 5_000_000) throw new Error('Original controlled image must have a known size no larger than 5 MB');
  if (!result.dimensions || result.dimensions.width < 1 || result.dimensions.height < 1
    || result.dimensions.width > 8_192 || result.dimensions.height > 8_192) {
    throw new Error('Original controlled image dimensions are missing or exceed 8192 by 8192');
  }
}

export function assertControlledPostMatches(post: BufferPost, receipt: ControlledTestPostSpec & { postId?: string; text?: string }): void {
  const expectedText = receipt.text ?? controlledTestText(receipt.runId);
  if (receipt.postId && post.id !== receipt.postId) throw new Error('Controlled post identity does not match the signed receipt');
  if (post.channelId !== receipt.channelId) throw new Error('Controlled post channel changed');
  if (post.status !== 'scheduled') throw new Error('Controlled post is not scheduled');
  if (post.dueAt !== receipt.dueAt) throw new Error('Controlled post publication time changed');
  if (post.shareMode !== 'customScheduled' || post.schedulingType !== 'automatic') throw new Error('Controlled post scheduling mode changed');
  if (post.text !== expectedText) throw new Error('Controlled post text changed');
  if (!Array.isArray(post.tags) || post.tags.length !== 0) throw new Error('Controlled post tags are not empty');
  if (!Array.isArray(post.assets) || post.assets.length !== 1 || post.assets[0].type !== 'image'
    || post.assets[0].source !== receipt.originalUrl) throw new Error('Controlled post image does not match the reviewed original');
}

export function sealControlledReceipt(receipt: ControlledTestPostReceipt, secret: Buffer): string {
  const payload = Buffer.from(JSON.stringify(receipt)).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function openControlledReceipt(value: string, secret: Buffer): ControlledTestPostReceipt {
  const separator = value.lastIndexOf('.');
  if (separator < 1) throw new Error('Controlled post receipt is invalid');
  const payload = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  if (!safeEqual(signature, expected)) throw new Error('Controlled post receipt signature is invalid');
  const receipt = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ControlledTestPostReceipt;
  validateControlledTestSpec(receipt, Date.parse(receipt.createdAt));
  if (!receipt.postId || receipt.text !== controlledTestText(receipt.runId)) throw new Error('Controlled post receipt contents are invalid');
  return receipt;
}

export class ControlledTestPostService {
  readonly store: Store;
  readonly buffer: BufferClient;
  readonly probe: typeof probeMediaUrl;
  readonly now: () => number;

  constructor(
    store: Store,
    buffer: BufferClient,
    probe: typeof probeMediaUrl = probeMediaUrl,
    now: () => number = Date.now,
  ) {
    this.store = store;
    this.buffer = buffer;
    this.probe = probe;
    this.now = now;
  }

  async create(spec: ControlledTestPostSpec, confirmation: string): Promise<{ receipt: ControlledTestPostReceipt; requestId?: string }> {
    validateControlledTestSpec(spec, this.now());
    if (confirmation !== createConfirmation(spec.runId)) throw new Error(`Confirmation must exactly match ${createConfirmation(spec.runId)}`);
    if (!this.store.getConnection(spec.tenantId, spec.connectionId)) throw new Error('Buffer connection does not belong to this tenant');
    const discovery = await this.buffer.discover(spec.tenantId, spec.connectionId);
    const channels = discovery.organizations.flatMap((organization) => organization.channels);
    const channel = channels.find((item) => item.id === spec.channelId);
    if (!channel || channel.service !== 'twitter' || channel.isDisconnected || channel.isLocked) {
      throw new Error('Controlled post channel is unavailable, disconnected, locked, or not X');
    }
    assertProbeReady(await this.probe(spec.originalUrl));
    const text = controlledTestText(spec.runId);
    const result = await this.buffer.graphql<{ createPost: MutationResult }>(spec.tenantId, spec.connectionId, `
      mutation GabelCreateControlledTestPost($input: CreatePostInput!) {
        createPost(input: $input) {
          ... on PostActionSuccess { post { ${POST_FIELDS} } }
          ... on MutationError { message }
        }
      }`, { input: {
        channelId: spec.channelId,
        text,
        schedulingType: 'automatic',
        mode: 'customScheduled',
        dueAt: spec.dueAt,
        needsApproval: false,
        saveToDraft: false,
        assets: [{ image: { url: spec.originalUrl, metadata: { altText: 'Disposable Gabel controlled repair test image' } } }],
      } });
    const created = result.data.createPost.post;
    if (!created) throw new Error(result.data.createPost.message ?? 'Buffer did not confirm controlled post creation');
    const receipt: ControlledTestPostReceipt = { ...spec, postId: created.id, text, createdAt: new Date(this.now()).toISOString() };
    try {
      assertControlledPostMatches(created, receipt);
      const fresh = await this.buffer.getPost(spec.tenantId, spec.connectionId, created.id);
      assertControlledPostMatches(fresh.post, receipt);
      if (!fresh.post.allowedActions.includes('updatePost') || !fresh.post.allowedActions.includes('deletePost')) {
        throw new Error('Fresh controlled post does not authorize both update and cleanup');
      }
    } catch (error) {
      throw new ControlledPostCreationAmbiguousError(
        `Buffer returned a created post but fresh verification failed: ${error instanceof Error ? error.message : 'unknown verification error'}`,
        receipt,
      );
    }
    return { receipt, requestId: result.requestId };
  }

  async inspect(receipt: ControlledTestPostReceipt): Promise<BufferPost> {
    const fresh = await this.buffer.getPost(receipt.tenantId, receipt.connectionId, receipt.postId);
    assertControlledPostMatches(fresh.post, receipt);
    return fresh.post;
  }

  async delete(receipt: ControlledTestPostReceipt, confirmation: string): Promise<{ id: string; requestId?: string }> {
    if (confirmation !== deleteConfirmation(receipt.postId)) throw new Error(`Confirmation must exactly match ${deleteConfirmation(receipt.postId)}`);
    if (!this.store.getConnection(receipt.tenantId, receipt.connectionId)) throw new Error('Buffer connection does not belong to this tenant');
    const fresh = await this.inspect(receipt);
    if (!fresh.allowedActions.includes('deletePost')) throw new Error('Buffer does not currently authorize deletion of this controlled post');
    const result = await this.buffer.graphql<{ deletePost: { id?: string; message?: string } }>(receipt.tenantId, receipt.connectionId, `
      mutation GabelDeleteControlledTestPost($input: DeletePostInput!) {
        deletePost(input: $input) {
          ... on DeletePostSuccess { id }
          ... on MutationError { message }
        }
      }`, { input: { id: receipt.postId } });
    if (result.data.deletePost.id !== receipt.postId) throw new Error(result.data.deletePost.message ?? 'Buffer did not confirm deletion of the exact controlled post');
    return { id: receipt.postId, requestId: result.requestId };
  }
}
