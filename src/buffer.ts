import { randomUUID } from 'node:crypto';
import type { Config } from './config.ts';
import type { Store } from './db.ts';
import { decrypt, encrypt, sanitize } from './security.ts';
import type { BufferPost, DbConnection, GraphQlEnvelope, TokenResponse } from './types.ts';

export class BufferError extends Error {
  readonly kind: 'http' | 'graphql' | 'auth' | 'rate_limit' | 'network' | 'invalid_response';
  readonly details: unknown;
  readonly requestId?: string;
  readonly retryAfter?: number;
  readonly httpStatus?: number;
  readonly operationName?: string;
  constructor(
    message: string,
    kind: 'http' | 'graphql' | 'auth' | 'rate_limit' | 'network' | 'invalid_response',
    details: unknown = undefined,
    requestId?: string,
    retryAfter?: number,
    httpStatus?: number,
    operationName?: string,
  ) {
    super(message);
    this.kind = kind;
    this.details = details;
    this.requestId = requestId;
    this.retryAfter = retryAfter;
    this.httpStatus = httpStatus;
    this.operationName = operationName;
  }
}

export function graphqlOperationName(query: string): string | undefined {
  return query.match(/\b(?:query|mutation)\s+([_A-Za-z][_0-9A-Za-z]*)/)?.[1];
}

export function safeBufferErrorDiagnostic(error: BufferError): Record<string, unknown> {
  return {
    kind: error.kind,
    message: error.message,
    operationName: error.operationName,
    httpStatus: error.httpStatus,
    requestId: error.requestId,
    retryAfter: error.retryAfter,
    details: sanitize(error.details),
  };
}

type FetchLike = typeof fetch;
type GqlResult<T> = { data: T; requestId?: string };
const refreshes = new Map<string, Promise<string>>();

function isTokenResponse(value: unknown): value is TokenResponse {
  const v = value as Partial<TokenResponse>;
  return !!v && typeof v.access_token === 'string' && typeof v.expires_in === 'number' && v.token_type === 'Bearer' && typeof v.scope === 'string';
}

export async function tokenRequest(config: Config, body: URLSearchParams, fetcher: FetchLike = fetch): Promise<TokenResponse> {
  if (config.bufferClientSecret) body.set('client_secret', config.bufferClientSecret);
  let response: Response;
  try {
    response = await fetcher('https://auth.buffer.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
  } catch (error) {
    throw new BufferError('Buffer token endpoint could not be reached', 'network', sanitize(error));
  }
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok || !isTokenResponse(json)) {
    const oauthError = (json as { error?: string } | null)?.error;
    const kind = response.status === 401 || oauthError === 'invalid_grant' || oauthError === 'invalid_client' ? 'auth' : 'http';
    throw new BufferError('Buffer rejected the token request', kind, sanitize(json));
  }
  return json;
}

export async function exchangeAuthorizationCode(config: Config, code: string, verifier: string, fetcher: FetchLike = fetch): Promise<TokenResponse> {
  return tokenRequest(config, new URLSearchParams({
    client_id: config.bufferClientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.bufferRedirectUri,
    code_verifier: verifier,
  }), fetcher);
}

export class BufferClient {
  readonly config: Config;
  readonly store: Store;
  readonly fetcher: FetchLike;

  constructor(config: Config, store: Store, fetcher: FetchLike = fetch) {
    this.config = config;
    this.store = store;
    this.fetcher = fetcher;
  }

  private async refresh(connection: DbConnection, force = false): Promise<string> {
    const running = refreshes.get(connection.id);
    if (running) return running;
    const promise = (async () => {
      if (!connection.refresh_token_ciphertext) {
        this.store.requireReauth(connection.id);
        throw new BufferError('No refresh token is available; reauthorization is required', 'auth');
      }
      const current = this.store.getConnection(connection.tenant_id, connection.id);
      if (!current) throw new BufferError('Connection no longer exists', 'auth');
      if (current.token_version !== connection.token_version || (!force && Date.parse(current.access_expires_at) > Date.now() + 60_000)) {
        return decrypt(current.access_token_ciphertext, this.config.encryptionKey);
      }
      try {
        const tokens = await tokenRequest(this.config, new URLSearchParams({
          client_id: this.config.bufferClientId,
          grant_type: 'refresh_token',
          refresh_token: decrypt(current.refresh_token_ciphertext!, this.config.encryptionKey),
        }), this.fetcher);
        if (!tokens.refresh_token) throw new BufferError('Refresh response omitted the required rotated refresh token', 'invalid_response');
        const saved = this.store.rotateTokens(current.id, current.token_version,
          encrypt(tokens.access_token, this.config.encryptionKey), encrypt(tokens.refresh_token, this.config.encryptionKey),
          new Date(Date.now() + tokens.expires_in * 1000).toISOString(), tokens.scope);
        if (!saved) throw new BufferError('Token rotation raced with another process; refusing to reuse the single-use token', 'auth');
        return tokens.access_token;
      } catch (error) {
        if (error instanceof BufferError && error.kind === 'auth') this.store.requireReauth(current.id);
        throw error;
      }
    })().finally(() => refreshes.delete(connection.id));
    refreshes.set(connection.id, promise);
    return promise;
  }

  async accessToken(connection: DbConnection): Promise<string> {
    if (connection.status !== 'active') throw new BufferError('Buffer authorization has been revoked or expired', 'auth');
    if (Date.parse(connection.access_expires_at) <= Date.now() + 60_000) return this.refresh(connection);
    return decrypt(connection.access_token_ciphertext, this.config.encryptionKey);
  }

  async rawGraphql<T>(token: string, query: string, variables: Record<string, unknown> = {}): Promise<GqlResult<T>> {
    const operationName = graphqlOperationName(query);
    let response: Response;
    try {
      response = await this.fetcher('https://api.buffer.com', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
    } catch (error) {
      throw new BufferError('Buffer API request timed out or failed before a response was received', 'network', sanitize(error), undefined, undefined, undefined, operationName);
    }
    const requestId = response.headers.get('x-request-id') ?? response.headers.get('request-id') ?? undefined;
    const envelope = await response.json().catch(() => null) as GraphQlEnvelope<T> | null;
    if (response.status === 401) throw new BufferError('Buffer authorization is invalid or revoked', 'auth', sanitize(envelope), requestId, undefined, response.status, operationName);
    if (response.status === 429) throw new BufferError('Buffer rate limit exceeded', 'rate_limit', sanitize(envelope), requestId,
      Number(response.headers.get('retry-after') ?? 0) || undefined, response.status, operationName);
    if (!response.ok) throw new BufferError(`Buffer returned HTTP ${response.status}`, 'http', sanitize(envelope), requestId, undefined, response.status, operationName);
    if (!envelope || typeof envelope !== 'object') throw new BufferError('Buffer returned an invalid JSON response', 'invalid_response', undefined, requestId, undefined, response.status, operationName);
    if (envelope.errors?.length) throw new BufferError('Buffer returned GraphQL errors', 'graphql', sanitize(envelope.errors), requestId, undefined, response.status, operationName);
    if (envelope.data == null) throw new BufferError('Buffer response contained no data', 'invalid_response', sanitize(envelope), requestId, undefined, response.status, operationName);
    return { data: envelope.data, requestId };
  }

  async graphql<T>(tenantId: string, connectionId: string, query: string, variables: Record<string, unknown> = {}): Promise<GqlResult<T>> {
    let connection = this.store.getConnection(tenantId, connectionId);
    if (!connection) throw new BufferError('Connection not found for this tenant', 'auth');
    let token = await this.accessToken(connection);
    try {
      return await this.rawGraphql<T>(token, query, variables);
    } catch (error) {
      if (!(error instanceof BufferError) || error.kind !== 'auth') throw error;
      connection = this.store.getConnection(tenantId, connectionId);
      if (!connection) throw error;
      token = await this.refresh(connection, true);
      return this.rawGraphql<T>(token, query, variables);
    }
  }

  async discover(tenantId: string, connectionId: string): Promise<{ organizations: Array<{ id: string; name: string; channels: Array<Record<string, unknown>> }>; posts: BufferPost[] }> {
    const account = await this.graphql<{ account: { organizations: Array<{ id: string; name: string }> } }>(tenantId, connectionId, `
      query GabelOrganizations { account { organizations { id name } } }
    `);
    const organizations = [];
    const allPosts: BufferPost[] = [];
    for (const org of account.data.account.organizations) {
      const channelResult = await this.graphql<{ channels: Array<Record<string, unknown>> }>(tenantId, connectionId, `
        query GabelChannels($organizationId: OrganizationId!) {
          channels(input: { organizationId: $organizationId }) {
            id name displayName service isDisconnected isLocked
          }
        }`, { organizationId: org.id });
      const channels = channelResult.data.channels;
      organizations.push({ ...org, channels });
      const organizationPosts: BufferPost[] = [];
      let after: string | null = null;
      do {
        const pageResult: GqlResult<{ posts: { edges: Array<{ node: BufferPost }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }> = await this.graphql(tenantId, connectionId, POST_LIST_QUERY,
          { organizationId: org.id, first: 50, after });
        const posts: BufferPost[] = pageResult.data.posts.edges.map((edge: { node: BufferPost }) => edge.node);
        allPosts.push(...posts);
        organizationPosts.push(...posts);
        after = pageResult.data.posts.pageInfo.hasNextPage ? pageResult.data.posts.pageInfo.endCursor : null;
        if (pageResult.data.posts.pageInfo.hasNextPage && !after) throw new BufferError('Pagination said another page exists but omitted endCursor', 'invalid_response');
      } while (after);
      this.store.replacePosts(tenantId, connectionId, org.id, organizationPosts);
    }
    this.store.removePostsOutsideOrganizations(tenantId, connectionId, organizations.map((organization) => organization.id));
    this.store.replaceDiscovery(tenantId, connectionId, organizations);
    this.store.addEvidence({ id: randomUUID(), tenantId, operation: 'account_channel_post_discovery', outcome: 'success', sanitized: {
      organizationCount: organizations.length, channelCount: organizations.reduce((n, o) => n + o.channels.length, 0), postCount: allPosts.length,
    }});
    return { organizations, posts: allPosts };
  }

  async getPost(tenantId: string, connectionId: string, postId: string): Promise<{ post: BufferPost; requestId?: string }> {
    const result = await this.graphql<{ post: BufferPost }>(tenantId, connectionId, POST_QUERY, { id: postId });
    return { post: result.data.post, requestId: result.requestId };
  }
}

export const POST_FIELDS = `
  id channelId status dueAt shareMode schedulingType text updatedAt allowedActions
  metadata { ... on CommonPostMetadata { type } }
  tags { id name }
  assets {
    id type mimeType source thumbnail
    ... on ImageAsset { image { altText animatedThumbnail userTags { handle x y } } }
    ... on VideoAsset { video { thumbnailOffset title } }
    ... on DocumentAsset { document { title thumbnails } }
  }`;

export const POST_QUERY = `query GabelPost($id: PostId!) { post(input: { id: $id }) { ${POST_FIELDS} } }`;
export const POST_LIST_QUERY = `query GabelScheduledPosts($organizationId: OrganizationId!, $first: Int!, $after: String) {
  posts(first: $first, after: $after, input: {
    organizationId: $organizationId
    sort: [{ field: dueAt, direction: asc }, { field: createdAt, direction: desc }]
    filter: { status: [scheduled] }
  }) { edges { node { ${POST_FIELDS} } } pageInfo { hasNextPage endCursor } }
}`;
