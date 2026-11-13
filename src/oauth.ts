import type { Config } from './config.ts';
import { Store } from './db.ts';
import type { PostgresStore } from './postgres-db.ts';
import type { AppStore } from './persistence.ts';
import { decrypt, encrypt, pkceChallenge, randomToken, sha256 } from './security.ts';

export const BUFFER_SCOPES = ['account:read', 'posts:read', 'posts:write', 'offline_access'] as const;

export type OAuthReconnect = { connectionId: string; expectedTokenVersion: number };
export type ConsumedOAuth = { verifier: string; reconnect?: OAuthReconnect };

type BegunOAuth = { url: string; state: string; verifier: string };

export function beginOAuth(store: Store, config: Config, sessionHash: string, reconnect?: OAuthReconnect): BegunOAuth;
export function beginOAuth(store: PostgresStore, config: Config, sessionHash: string, reconnect?: OAuthReconnect): Promise<BegunOAuth>;
export function beginOAuth(store: AppStore, config: Config, sessionHash: string, reconnect?: OAuthReconnect): BegunOAuth | Promise<BegunOAuth>;
export function beginOAuth(store: AppStore, config: Config, sessionHash: string, reconnect?: OAuthReconnect): BegunOAuth | Promise<BegunOAuth> {
  const state = randomToken(32);
  const verifier = randomToken(64);
  const persist = store.setOAuthSession(sessionHash, sha256(state), encrypt(verifier, config.encryptionKey), new Date(Date.now() + 10 * 60_000).toISOString(), reconnect);
  const url = new URL('https://auth.buffer.com/auth');
  url.search = new URLSearchParams({
    client_id: config.bufferClientId,
    redirect_uri: config.bufferRedirectUri,
    response_type: 'code',
    scope: BUFFER_SCOPES.join(' '),
    state,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: 'S256',
    prompt: 'consent',
  }).toString();
  const result = { url: url.toString(), state, verifier };
  return store instanceof Store ? result : Promise.resolve(persist).then(() => result);
}

export function consumeOAuth(store: Store, config: Config, sessionHash: string, returnedState: string): ConsumedOAuth | undefined;
export function consumeOAuth(store: PostgresStore, config: Config, sessionHash: string, returnedState: string): Promise<ConsumedOAuth | undefined>;
export function consumeOAuth(store: AppStore, config: Config, sessionHash: string, returnedState: string): ConsumedOAuth | undefined | Promise<ConsumedOAuth | undefined>;
export function consumeOAuth(store: AppStore, config: Config, sessionHash: string, returnedState: string): ConsumedOAuth | undefined | Promise<ConsumedOAuth | undefined> {
  if (!returnedState) return undefined;
  const present = (row: Awaited<ReturnType<AppStore['consumeOAuthSession']>>): ConsumedOAuth | undefined => row ? {
    verifier: decrypt(row.pkce_verifier_ciphertext, config.encryptionKey),
    ...(row.connection_id && row.expected_token_version != null
      ? { reconnect: { connectionId: row.connection_id, expectedTokenVersion: row.expected_token_version } } : {}),
  } : undefined;
  if (store instanceof Store) return present(store.consumeOAuthSession(sessionHash, sha256(returnedState)));
  return store.consumeOAuthSession(sessionHash, sha256(returnedState)).then(present);
}
