import { resolve } from 'node:path';
import { BufferClient, safeBufferErrorDiagnostic, BufferError } from '../src/buffer.ts';
import type { Config } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { probeMediaUrl } from '../src/media-security.ts';
import { buildCompleteAssetList } from '../src/edit.ts';

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

const config: Config = {
  appOrigin: process.env.APP_ORIGIN ?? 'https://localhost', tlsOriginHostname: "localhost",
  port: 0,
  bufferClientId: required('BUFFER_CLIENT_ID'),
  bufferClientSecret: process.env.BUFFER_CLIENT_SECRET?.trim() || undefined,
  bufferRedirectUri: process.env.BUFFER_REDIRECT_URI ?? 'https://localhost/auth/buffer/callback',
  encryptionKey: key('APP_ENCRYPTION_KEY'),
  cookieSecret: Buffer.alloc(32),
  databasePath: resolve(process.env.DATABASE_PATH ?? './data/gabel.db'),
  requestTimeoutMs: Number(process.env.BUFFER_REQUEST_TIMEOUT_MS ?? 15_000),
  operatorName: 'not-used-by-readonly-verifier',
  supportEmail: 'not-used@example.invalid',
  privacyEmail: 'not-used@example.invalid',
};

const argument = (name: string): string | undefined => process.argv
  .find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
const tenantId = argument('--tenant-id') ?? process.env.GABEL_VERIFY_TENANT_ID;
if (!tenantId?.trim()) {
  throw new Error('Set --tenant-id=<authenticated tenant> or GABEL_VERIFY_TENANT_ID for tenant-scoped verification');
}

const store = new Store(config.databasePath);
try {
  const connection = store.requireAuthenticatedTenantConnection(tenantId);
  const client = new BufferClient(config, store);
  const identity = await client.graphql<{ account: { id: string } }>(connection.tenant_id, connection.id,
    'query GabelLiveAccountIdentity { account { id } }');
  const discovery = await client.discover(connection.tenant_id, connection.id);
  const assets = discovery.posts.flatMap((post) => post.assets);
  const mediaResults = await Promise.all(assets.slice(0, 10).map((asset) => probeMediaUrl(asset.source)));
  const expectedOrganization = argument('--expected-organization') ?? process.env.EXPECTED_BUFFER_ORGANIZATION;
  const expectedChannel = argument('--expected-channel') ?? process.env.EXPECTED_BUFFER_CHANNEL;
  const discoveredChannels = discovery.organizations.flatMap((organization) => organization.channels);
  const singlePost = discovery.posts.length === 1 ? discovery.posts[0] : undefined;
  let completeAssetListReconstructable = false;
  if (singlePost) {
    try {
      buildCompleteAssetList(singlePost, new Map());
      completeAssetListReconstructable = true;
    } catch {
      completeAssetListReconstructable = false;
    }
  }
  const summary = {
    verifiedAt: new Date().toISOString(),
    liveReadOnlyOperation: true,
    accountIdentityMatchedStoredConnection: identity.data.account.id === connection.buffer_account_id,
    organizationCount: discovery.organizations.length,
    channelCount: discovery.organizations.reduce((total, organization) => total + organization.channels.length, 0),
    expectedOrganizationMatched: expectedOrganization == null ? undefined
      : discovery.organizations.some((organization) => organization.name === expectedOrganization),
    expectedChannelMatched: expectedChannel == null ? undefined
      : discoveredChannels.some((channel) => channel.name === expectedChannel || channel.displayName === expectedChannel),
    scheduledPostCount: discovery.posts.length,
    postsWithDueAt: discovery.posts.filter((post) => Boolean(post.dueAt)).length,
    postsWithAssets: discovery.posts.filter((post) => post.assets.length > 0).length,
    assetCount: assets.length,
    assetTypes: Object.fromEntries([...new Set(assets.map((asset) => asset.type))].sort().map((type) => [type, assets.filter((asset) => asset.type === type).length])),
    assetFields: {
      sourcePresent: assets.filter((asset) => Boolean(asset.source)).length,
      thumbnailPresent: assets.filter((asset) => Boolean(asset.thumbnail)).length,
      imageMetadataPresent: assets.filter((asset) => Boolean(asset.image)).length,
      videoMetadataPresent: assets.filter((asset) => Boolean(asset.video)).length,
      documentMetadataPresent: assets.filter((asset) => Boolean(asset.document)).length,
    },
    mediaProbe: {
      checkedCount: mediaResults.length,
      omittedCount: Math.max(0, assets.length - mediaResults.length),
      outcomes: Object.fromEntries(['reachable', 'unreachable', 'unsafe', 'error'].map((outcome) =>
        [outcome, mediaResults.filter((result) => result.outcome === outcome).length])),
      results: mediaResults.map((result, position) => ({
        position,
        classification: result.outcome === 'reachable' ? 'ACCESSIBLE'
          : result.outcome === 'unreachable' ? 'INACCESSIBLE' : 'INCONCLUSIVE',
        outcome: result.outcome,
        httpStatus: result.httpStatus,
        contentType: result.contentType,
        errorCategory: result.errorCategory,
        redirects: result.redirects,
        reason: result.reason,
      })),
    },
    singleScheduledPost: singlePost ? {
      status: singlePost.status,
      scheduledAt: singlePost.dueAt,
      channelAssociationMatchesDiscoveredChannel: discoveredChannels.some((channel) => channel.id === singlePost.channelId),
      updatePostAllowed: singlePost.allowedActions.includes('updatePost'),
      textPresent: singlePost.text.length > 0,
      shareMode: singlePost.shareMode,
      schedulingType: singlePost.schedulingType,
      metadataType: singlePost.metadata?.type,
      tagCount: singlePost.tags.length,
      completeAssetListReconstructable,
      assets: singlePost.assets.map((asset, position) => ({
        position,
        type: asset.type,
        mimeType: asset.mimeType,
        sourcePresent: Boolean(asset.source),
        thumbnailPresent: Boolean(asset.thumbnail),
        imageMetadata: asset.image ? {
          altTextPresent: Boolean(asset.image.altText),
          animatedThumbnailPresent: Boolean(asset.image.animatedThumbnail),
          userTagCount: asset.image.userTags?.length ?? 0,
        } : undefined,
        videoMetadataPresent: Boolean(asset.video),
        documentMetadataPresent: Boolean(asset.document),
      })),
    } : undefined,
    mutationSent: false,
  };
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  if (error instanceof BufferError) console.error(JSON.stringify({ verifiedAt: new Date().toISOString(), liveReadOnlyOperation: true,
    success: false, error: safeBufferErrorDiagnostic(error), mutationSent: false }, null, 2));
  else console.error(JSON.stringify({ verifiedAt: new Date().toISOString(), liveReadOnlyOperation: true,
    success: false, error: error instanceof Error ? error.message : 'Unknown failure', mutationSent: false }, null, 2));
  process.exitCode = 1;
} finally {
  store.close();
}
