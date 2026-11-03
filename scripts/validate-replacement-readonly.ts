import { resolve } from 'node:path';
import { BufferClient, BufferError, safeBufferErrorDiagnostic } from '../src/buffer.ts';
import type { Config } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { probeMediaUrl } from '../src/media-security.ts';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function key(name: string): Buffer {
  const value = Buffer.from(required(name), 'base64url');
  if (value.length !== 32) throw new Error(`${name} must decode to exactly 32 bytes`);
  return value;
}

const candidate = process.argv[2];
if (!candidate) throw new Error('A replacement media URL argument is required');

const config: Config = {
  appOrigin: process.env.APP_ORIGIN ?? 'https://localhost', port: 0,
  bufferClientId: required('BUFFER_CLIENT_ID'), bufferClientSecret: process.env.BUFFER_CLIENT_SECRET?.trim() || undefined,
  bufferRedirectUri: process.env.BUFFER_REDIRECT_URI ?? 'https://localhost/auth/buffer/callback',
  encryptionKey: key('APP_ENCRYPTION_KEY'), cookieSecret: Buffer.alloc(32),
  databasePath: resolve(process.env.DATABASE_PATH ?? './data/gabel.db'),
  requestTimeoutMs: Number(process.env.BUFFER_REQUEST_TIMEOUT_MS ?? 15_000),
  operatorName: 'not-used-by-readonly-verifier', supportEmail: 'not-used@example.invalid', privacyEmail: 'not-used@example.invalid',
};

type ValidationRule = {
  __typename: string;
  property: string;
  allowedFormats?: string[];
  maxMegabytes?: number;
};
type ContentConfiguration = { configurationContentTypes: string[]; supportedProperties: string[]; rules: ValidationRule[] };
type ChannelConfiguration = { channelId: string; service: string; channelType: string; content: ContentConfiguration[] };
type ServiceConfiguration = { service: string; channelType: string; content: ContentConfiguration[] };

const store = new Store(config.databasePath);
try {
  const connections = store.db.prepare(`SELECT id,tenant_id FROM buffer_connections WHERE status='active' ORDER BY created_at`).all() as Array<{ id: string; tenant_id: string }>;
  if (connections.length !== 1) throw new Error(`Expected exactly one active Buffer connection; found ${connections.length}`);
  const connection = connections[0];
  const client = new BufferClient(config, store);
  const discovery = await client.discover(connection.tenant_id, connection.id);
  if (discovery.posts.length !== 1) throw new Error(`Expected exactly one scheduled post; found ${discovery.posts.length}`);
  const post = discovery.posts[0];
  const organization = discovery.organizations.find((item) => item.channels.some((channel) => channel.id === post.channelId));
  if (!organization) throw new Error('Scheduled post channel was not found in the discovered organization');

  const configuration = await client.graphql<{ configuration: { channels: ChannelConfiguration[]; services: ServiceConfiguration[] } }>(
    connection.tenant_id, connection.id, `
      query GabelReplacementChannelConfiguration($organizationId: OrganizationId!) {
        configuration(input: { organizationId: $organizationId }) {
          channels {
            channelId service channelType
            content {
              configurationContentTypes supportedProperties
              rules {
                __typename property
                ... on FormatRule { allowedFormats }
                ... on FileSizeRule { maxMegabytes }
              }
            }
          }
          services {
            service channelType
            content {
              configurationContentTypes supportedProperties
              rules {
                __typename property
                ... on FormatRule { allowedFormats }
                ... on FileSizeRule { maxMegabytes }
              }
            }
          }
        }
      }`, { organizationId: organization.id });
  const channel = configuration.data.configuration.channels.find((item) => item.channelId === post.channelId);
  if (!channel) throw new Error('Live configuration omitted the scheduled post channel');
  const contentType = post.metadata?.type ?? 'post';
  const content = channel.content.find((item) => item.configurationContentTypes.includes(contentType));
  const service = configuration.data.configuration.services.find((item) => item.service === channel.service && item.channelType === channel.channelType);
  const serviceContent = service?.content.find((item) => item.configurationContentTypes.includes(contentType));
  const liveSchema = await client.graphql<{ __type: { enumValues: Array<{ name: string }> } | null }>(connection.tenant_id, connection.id,
    `query GabelMediaFormatEnum { __type(name: "MediaFormat") { enumValues { name } } }`);
  const liveMediaFormats = liveSchema.data.__type?.enumValues.map((item) => item.name).sort() ?? [];
  const probe = await probeMediaUrl(candidate, { timeoutMs: 10_000 });
  const imageFormatRules = content?.rules.filter((rule) => rule.__typename === 'FormatRule' && rule.property === 'image') ?? [];
  const imageSizeRules = content?.rules.filter((rule) => rule.__typename === 'FileSizeRule' && rule.property === 'image') ?? [];
  const allowedFormats = [...new Set(imageFormatRules.flatMap((rule) => rule.allowedFormats ?? []))].sort();
  const serviceAllowedFormats = [...new Set((serviceContent?.rules ?? [])
    .filter((rule) => rule.__typename === 'FormatRule' && rule.property === 'image')
    .flatMap((rule) => rule.allowedFormats ?? []))].sort();
  const maxMegabytes = imageSizeRules.length ? Math.min(...imageSizeRules.map((rule) => rule.maxMegabytes ?? Number.POSITIVE_INFINITY)) : undefined;
  const declaredMatchesSignature = probe.declaredFormat !== 'unknown' && probe.declaredFormat === probe.detectedFormat;
  const formatKnownToLiveSchema = probe.detectedFormat !== 'unknown' && liveMediaFormats.includes(probe.detectedFormat);
  const formatSupported = allowedFormats.length && probe.detectedFormat !== 'unknown'
    ? allowedFormats.includes(probe.detectedFormat) : undefined;
  const sizeKnown = probe.fileSizeBytes != null;
  const sizeWithinLimit = sizeKnown && maxMegabytes != null ? probe.fileSizeBytes! <= maxMegabytes * 1_000_000 : undefined;
  const mediaValidationPassed = probe.outcome === 'reachable' && declaredMatchesSignature && sizeKnown && probe.dimensions != null;
  const bufferCompatibility = !formatKnownToLiveSchema ? 'incompatible'
    : formatSupported === false || sizeWithinLimit === false ? 'incompatible'
    : formatSupported === true && sizeWithinLimit === true ? 'confirmed-by-live-channel-rules'
    : 'supported-format-with-channel-limits-unresolved';

  console.log(JSON.stringify({
    verifiedAt: new Date().toISOString(), liveReadOnlyOperation: true, candidateUrlPrinted: false,
    requestAuthenticationSent: false,
    replacement: {
      outcome: probe.outcome, errorCategory: probe.errorCategory, httpStatus: probe.httpStatus,
      dnsLookups: probe.dnsLookups, resolvedAddressCount: probe.resolvedAddressCount,
      addressFamilies: probe.addressFamilies, allAddressesPublic: probe.allAddressesPublic,
      tlsVerified: probe.outcome === 'reachable', redirects: probe.redirects,
      contentType: probe.contentType, declaredFormat: probe.declaredFormat, detectedFormat: probe.detectedFormat,
      declaredMatchesSignature, dimensions: probe.dimensions, fileSizeBytes: probe.fileSizeBytes, durationMs: probe.durationMs,
    },
    target: {
      scheduledPostCount: discovery.posts.length, status: post.status,
      updatePostAllowed: post.allowedActions.includes('updatePost'), assetCount: post.assets.length,
      channelService: channel.service, channelType: channel.channelType, configurationContentType: contentType,
      contentConfigurations: channel.content.map((entry) => ({
        configurationContentTypes: entry.configurationContentTypes,
        supportedProperties: entry.supportedProperties,
        rules: entry.rules.map((rule) => ({ type: rule.__typename, property: rule.property,
          allowedFormats: rule.allowedFormats, maxMegabytes: rule.maxMegabytes })),
      })),
      serviceContentConfigurations: service?.content.map((entry) => ({
        configurationContentTypes: entry.configurationContentTypes,
        supportedProperties: entry.supportedProperties,
        rules: entry.rules.map((rule) => ({ type: rule.__typename, property: rule.property,
          allowedFormats: rule.allowedFormats, maxMegabytes: rule.maxMegabytes })),
      })) ?? [],
      imagePropertySupported: content?.supportedProperties.includes('image') ?? false,
      allowedImageFormats: allowedFormats, maxImageMegabytes: maxMegabytes,
      serviceAllowedImageFormats: serviceAllowedFormats, liveMediaFormatEnum: liveMediaFormats,
      candidateFormatKnownToLiveSchema: formatKnownToLiveSchema,
      candidateFormatSupported: formatSupported, candidateSizeWithinLimit: sizeWithinLimit,
      bufferCompatibility,
    },
    mediaValidationPassed, editIntentCreated: false, mutationSent: false,
  }, null, 2));
} catch (error) {
  const safeError = error instanceof BufferError ? safeBufferErrorDiagnostic(error) : { message: 'Read-only replacement validation failed' };
  console.error(JSON.stringify({ verifiedAt: new Date().toISOString(), liveReadOnlyOperation: true,
    success: false, error: safeError, editIntentCreated: false, mutationSent: false }, null, 2));
  process.exitCode = 1;
} finally {
  store.close();
}
