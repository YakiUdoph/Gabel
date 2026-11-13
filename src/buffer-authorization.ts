import { randomUUID } from 'node:crypto';
import type { Config } from './config.ts';
import { Store } from './db.ts';
import type { PostgresStore } from './postgres-db.ts';
import type { AppStore } from './persistence.ts';
import { BufferError, safeBufferErrorDiagnostic } from './buffer.ts';
import { BUFFER_SCOPES, type ConsumedOAuth } from './oauth.ts';
import { encrypt } from './security.ts';
import type { TokenResponse } from './types.ts';

export type BufferAuthorizationFailure = 'insufficient_permissions' | 'account_mismatch' | 'stale_reauthorization' | 'connection_already_exists';

export class BufferAuthorizationError extends Error {
  readonly code: BufferAuthorizationFailure;
  readonly details: Record<string, unknown>;
  constructor(message: string, code: BufferAuthorizationFailure, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'BufferAuthorizationError';
    this.code = code;
    this.details = details;
  }
}

export function bufferAuthorizationFailureEvidence(error: unknown): Record<string, unknown> {
  if (error instanceof BufferAuthorizationError) return { reason: error.code, ...error.details };
  if (error instanceof BufferError) return { reason: error.kind, diagnostic: safeBufferErrorDiagnostic(error) };
  return { reason: 'unexpected_failure' };
}

type AuthorizationInput<T extends AppStore = AppStore> = { store: T; config: Config; tenantId: string;
  oauth: ConsumedOAuth; tokens: TokenResponse; accountId: string; now?: Date };
type AuthorizationResult = { connectionId: string; reauthorized: boolean };

function validateGrant(input: AuthorizationInput): { now: Date; access: string; refresh: string; expiresAt: string } {
  const { config, tokens } = input;
  const granted = new Set(tokens.scope.split(/\s+/).filter(Boolean));
  const missingScopes = BUFFER_SCOPES.filter((scope) => !granted.has(scope));
  if (missingScopes.length || !tokens.refresh_token) {
    throw new BufferAuthorizationError('Buffer did not grant all permissions needed to reconnect. Your existing connection was kept unchanged.',
      'insufficient_permissions', { missingScopes, refreshTokenReturned: Boolean(tokens.refresh_token) });
  }
  const now = input.now ?? new Date();
  return { now, access: encrypt(tokens.access_token, config.encryptionKey), refresh: encrypt(tokens.refresh_token, config.encryptionKey),
    expiresAt: new Date(now.getTime() + tokens.expires_in * 1000).toISOString() };
}

export function saveAuthorizedBufferConnection(input: AuthorizationInput<Store>): AuthorizationResult;
export function saveAuthorizedBufferConnection(input: AuthorizationInput<PostgresStore>): Promise<AuthorizationResult>;
export function saveAuthorizedBufferConnection(input: AuthorizationInput): AuthorizationResult | Promise<AuthorizationResult>;
export function saveAuthorizedBufferConnection(input: AuthorizationInput): AuthorizationResult | Promise<AuthorizationResult> {
  if (input.store instanceof Store) return saveSqliteAuthorizedConnection(input as AuthorizationInput<Store>);
  return savePostgresAuthorizedConnection(input as AuthorizationInput<PostgresStore>);
}

function saveSqliteAuthorizedConnection(input: AuthorizationInput<Store>): AuthorizationResult {
  const { store, tenantId, oauth, tokens, accountId } = input;
  const encrypted = validateGrant(input);
  if (oauth.reconnect) {
    const existing = store.getConnection(tenantId, oauth.reconnect.connectionId);
    if (!existing || existing.token_version !== oauth.reconnect.expectedTokenVersion || existing.status !== 'reauthorization_required') {
      throw new BufferAuthorizationError('This reconnect attempt is no longer current. The newer Buffer connection was kept unchanged.', 'stale_reauthorization');
    }
    if (existing.buffer_account_id !== accountId) throw new BufferAuthorizationError(
      'The authorized Buffer account does not match the account already connected to Gabel. Existing credentials and evidence were kept unchanged.', 'account_mismatch');
    const saved = store.reauthorizeConnection({ tenantId, connectionId: existing.id, expectedAccountId: accountId,
      expectedVersion: oauth.reconnect.expectedTokenVersion, access: encrypted.access, refresh: encrypted.refresh,
      expiresAt: encrypted.expiresAt, scopes: tokens.scope, now: encrypted.now });
    if (!saved) throw new BufferAuthorizationError('Another reconnect completed first. The newer Buffer connection was kept unchanged.', 'stale_reauthorization');
    return { connectionId: existing.id, reauthorized: true };
  }
  if (store.getConnection(tenantId)) throw new BufferAuthorizationError(
    'A Buffer connection already exists. Use Reconnect Buffer if it needs authorization.', 'connection_already_exists');
  const connectionId = store.upsertConnection({ id: randomUUID(), tenant_id: tenantId, buffer_account_id: accountId,
    access_token_ciphertext: encrypted.access, refresh_token_ciphertext: encrypted.refresh,
    access_expires_at: encrypted.expiresAt, scopes: tokens.scope });
  return { connectionId, reauthorized: false };
}

async function savePostgresAuthorizedConnection(input: AuthorizationInput<PostgresStore>): Promise<AuthorizationResult> {
  const { store, config, tenantId, oauth, tokens, accountId } = input;
  const encrypted = validateGrant(input);
  if (oauth.reconnect) {
    const existing = await store.getConnection(tenantId, oauth.reconnect.connectionId);
    if (!existing || existing.token_version !== oauth.reconnect.expectedTokenVersion || existing.status !== 'reauthorization_required') {
      throw new BufferAuthorizationError('This reconnect attempt is no longer current. The newer Buffer connection was kept unchanged.', 'stale_reauthorization');
    }
    if (existing.buffer_account_id !== accountId) {
      throw new BufferAuthorizationError('The authorized Buffer account does not match the account already connected to Gabel. Existing credentials and evidence were kept unchanged.',
        'account_mismatch');
    }
    const saved = await store.reauthorizeConnection({ tenantId, connectionId: existing.id, expectedAccountId: accountId,
      expectedVersion: oauth.reconnect.expectedTokenVersion, access: encrypted.access, refresh: encrypted.refresh,
      expiresAt: encrypted.expiresAt, scopes: tokens.scope, now: encrypted.now });
    if (!saved) throw new BufferAuthorizationError('Another reconnect completed first. The newer Buffer connection was kept unchanged.', 'stale_reauthorization');
    return { connectionId: existing.id, reauthorized: true };
  }
  if (await store.getConnection(tenantId)) {
    throw new BufferAuthorizationError('A Buffer connection already exists. Use Reconnect Buffer if it needs authorization.', 'connection_already_exists');
  }
  const connectionId = await store.upsertConnection({ id: randomUUID(), tenant_id: tenantId, buffer_account_id: accountId,
    access_token_ciphertext: encrypted.access, refresh_token_ciphertext: encrypted.refresh,
    access_expires_at: encrypted.expiresAt, scopes: tokens.scope });
  return { connectionId, reauthorized: false };
}
