import { createHash } from 'node:crypto';
import type { BufferClient } from './buffer.ts';
import type { Store } from './db.ts';
import { classifyMediaContentType, probeMediaUrl, type MediaProbeResult } from './media-security.ts';
import type { BufferAsset, BufferPost } from './types.ts';

const X_STATIC_IMAGE_MAX_BYTES = 5_000_000;
const X_STATIC_IMAGE_MAX_DIMENSION = 8_192;
const VALIDATION_MAX_AGE_MS = 10 * 60_000;

type Probe = typeof probeMediaUrl;
type ChannelConfiguration = {
  channelId: string;
  service: string;
  channelType: string;
};

export type ReplacementValidationEvidence = {
  position: number;
  validatedAt: string;
  expiresAt: string;
  channelService: string;
  requirementsSource: 'official-buffer-x-static-image-guidance';
  mediaFingerprint: string;
  format: string;
  fileSizeBytes: number;
  dimensions: { width: number; height: number };
};

export class ReplacementValidationError extends Error {}

function fingerprint(result: MediaProbeResult): string {
  return createHash('sha256').update(JSON.stringify({
    httpStatus: result.httpStatus,
    contentType: result.contentType?.split(';', 1)[0].trim().toLowerCase(),
    declaredFormat: result.declaredFormat,
    detectedFormat: result.detectedFormat,
    fileSizeBytes: result.fileSizeBytes,
    dimensions: result.dimensions,
    inspectionDigest: result.inspectionDigest,
  })).digest('base64url');
}

function rejectProbe(result: MediaProbeResult): never {
  if (result.outcome === 'unsafe') {
    throw new ReplacementValidationError('Could not verify the replacement because its destination is not allowed. No edit intent was created.');
  }
  if (result.outcome === 'error') {
    throw new ReplacementValidationError('Could not verify the replacement because the network check was inconclusive. No edit intent was created.');
  }
  throw new ReplacementValidationError('The replacement server returned a confirmed unsuccessful response. No edit intent was created.');
}

async function getChannelConfiguration(
  store: Store,
  buffer: BufferClient,
  tenantId: string,
  connectionId: string,
  post: BufferPost,
): Promise<ChannelConfiguration> {
  const context = store.db.prepare(`SELECT organization_id FROM posts
    WHERE tenant_id=? AND connection_id=? AND id=? AND channel_id=?`).get(
    tenantId, connectionId, post.id, post.channelId,
  ) as { organization_id: string } | undefined;
  if (!context) throw new ReplacementValidationError('Could not verify the destination channel for this post. No edit intent was created.');

  const result = await buffer.graphql<{ configuration: { channels: ChannelConfiguration[] } }>(tenantId, connectionId, `
    query GabelReplacementChannelConfiguration($organizationId: OrganizationId!) {
      configuration(input: { organizationId: $organizationId }) {
        channels { channelId service channelType }
      }
    }`, { organizationId: context.organization_id });
  const channel = result.data.configuration.channels.find((item) => item.channelId === post.channelId);
  if (!channel) throw new ReplacementValidationError('Could not verify the destination channel requirements. No edit intent was created.');
  return channel;
}

async function getLiveMediaFormats(buffer: BufferClient, tenantId: string, connectionId: string): Promise<Set<string>> {
  const result = await buffer.graphql<{ __type: { enumValues: Array<{ name: string }> } | null }>(tenantId, connectionId,
    `query GabelReplacementMediaFormats { __type(name: "MediaFormat") { enumValues { name } } }`);
  return new Set((result.data.__type?.enumValues ?? []).map((item) => item.name.toLowerCase()));
}

export async function validateImageReplacements(input: {
  store: Store;
  buffer: BufferClient;
  tenantId: string;
  connectionId: string;
  post: BufferPost;
  replacements: Map<number, string>;
  probe?: Probe;
  now?: number;
}): Promise<ReplacementValidationEvidence[]> {
  if (!input.replacements.size) throw new ReplacementValidationError('At least one replacement is required.');
  const now = input.now ?? Date.now();
  const channel = await getChannelConfiguration(input.store, input.buffer, input.tenantId, input.connectionId, input.post);
  if (channel.service !== 'twitter') {
    throw new ReplacementValidationError('Gabel cannot yet verify complete image requirements for this destination channel. No edit intent was created.');
  }
  const liveFormats = await getLiveMediaFormats(input.buffer, input.tenantId, input.connectionId);
  const runProbe = input.probe ?? probeMediaUrl;
  const evidence: ReplacementValidationEvidence[] = [];

  for (const [position, url] of input.replacements) {
    const asset: BufferAsset | undefined = input.post.assets[position];
    if (!asset || asset.type !== 'image' || !asset.image) {
      throw new ReplacementValidationError(`Replacement position ${position} is not a supported image asset. No edit intent was created.`);
    }
    const result = await runProbe(url);
    if (result.outcome !== 'reachable') rejectProbe(result);
    if (classifyMediaContentType(result.contentType) !== 'image'
      || !['jpeg', 'png'].includes(result.declaredFormat ?? '')
      || result.declaredFormat !== result.detectedFormat
      || !liveFormats.has(result.detectedFormat ?? '')) {
      throw new ReplacementValidationError('Unsupported file: the replacement MIME type and file signature must match a Buffer-supported JPEG or PNG. No edit intent was created.');
    }
    if (!result.fileSizeBytes || result.fileSizeBytes > X_STATIC_IMAGE_MAX_BYTES) {
      throw new ReplacementValidationError('Unsupported file: the replacement must have a verified size no greater than 5 MB for X. No edit intent was created.');
    }
    if (!result.dimensions || result.dimensions.width <= 0 || result.dimensions.height <= 0
      || result.dimensions.width > X_STATIC_IMAGE_MAX_DIMENSION
      || result.dimensions.height > X_STATIC_IMAGE_MAX_DIMENSION) {
      throw new ReplacementValidationError('Unsupported file: the replacement must have positive verified dimensions no greater than 8192 by 8192 pixels for X. No edit intent was created.');
    }
    if (!result.inspectionDigest) {
      throw new ReplacementValidationError('Could not verify enough replacement content to create a stable approval preview. No edit intent was created.');
    }
    const format = result.detectedFormat;
    if (!format) throw new ReplacementValidationError('Unsupported file: the replacement format could not be verified. No edit intent was created.');
    evidence.push({
      position,
      validatedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + VALIDATION_MAX_AGE_MS).toISOString(),
      channelService: channel.service,
      requirementsSource: 'official-buffer-x-static-image-guidance',
      mediaFingerprint: fingerprint(result),
      format,
      fileSizeBytes: result.fileSizeBytes,
      dimensions: result.dimensions,
    });
  }
  return evidence;
}

export function assertFreshMatchingValidation(
  previous: ReplacementValidationEvidence[],
  current: ReplacementValidationEvidence[],
  now = Date.now(),
): void {
  if (!previous.length || previous.some((item) => Date.parse(item.expiresAt) <= now)) {
    throw new ReplacementValidationError('Replacement validation is stale. No mutation was sent.');
  }
  if (JSON.stringify(previous.map(({ validatedAt: _validatedAt, expiresAt: _expiresAt, ...item }) => item))
    !== JSON.stringify(current.map(({ validatedAt: _validatedAt, expiresAt: _expiresAt, ...item }) => item))) {
    throw new ReplacementValidationError('The replacement changed after the approval preview. No mutation was sent.');
  }
}
