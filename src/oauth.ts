import type { Config } from './config.ts';
import type { Store } from './db.ts';
import { decrypt, encrypt, pkceChallenge, randomToken, sha256 } from './security.ts';

export const BUFFER_SCOPES = ['account:read', 'posts:read', 'posts:write', 'offline_access'] as const;

export type OAuthReconnect = { connectionId: string; expectedTokenVersion: number };
export type ConsumedOAuth = { verifier: string; reconnect?: OAuthReconnect };

export function beginOAuth(store: Store, config: Config, sessionHash: string, reconnect?: OAuthReconnect): { url: string; state: string; verifier: string } {
  const state = randomToken(32);
  const verifier = randomToken(64);
  store.setOAuthSession(sessionHash, sha256(state), encrypt(verifier, config.encryptionKey), new Date(Date.now() + 10 * 60_000).toISOString(), reconnect);
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
  return { url: url.toString(), state, verifier };
}

export function consumeOAuth(store: Store, config: Config, sessionHash: string, returnedState: string): ConsumedOAuth | undefined {
  if (!returnedState) return undefined;
  const row = store.consumeOAuthSession(sessionHash, sha256(returnedState));
  return row ? {
    verifier: decrypt(row.pkce_verifier_ciphertext, config.encryptionKey),
    ...(row.connection_id && row.expected_token_version != null
      ? { reconnect: { connectionId: row.connection_id, expectedTokenVersion: row.expected_token_version } } : {}),
  } : undefined;
}
