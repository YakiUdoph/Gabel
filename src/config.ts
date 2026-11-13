import { resolve } from 'node:path';

export type Config = {
  appOrigin: string;
  port: number;
  bufferClientId: string;
  bufferClientSecret?: string;
  bufferRedirectUri: string;
  encryptionKey: Buffer;
  cookieSecret: Buffer;
  databasePath: string;
  databaseUrl?: string;
  tlsKeyPath?: string;
  tlsCertPath?: string;
  tlsOriginHostname: string;
  requestTimeoutMs: number;
  operatorName: string;
  supportEmail: string;
  privacyEmail: string;
};

function required(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function key(name: string, env: NodeJS.ProcessEnv): Buffer {
  const encoded = required(name, env);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error(`${name} must be base64url without padding`);
  const value = Buffer.from(encoded, 'base64url');
  if (value.length !== 32) throw new Error(`${name} must decode to exactly 32 bytes`);
  return value;
}

function integer(name: string, raw: string, minimum: number, maximum: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function httpsUrl(name: string, raw: string): URL {
  let value: URL;
  try { value = new URL(raw); } catch { throw new Error(`${name} must be a valid absolute URL`); }
  if (value.protocol !== 'https:') throw new Error(`${name} must use HTTPS`);
  if (value.username || value.password) throw new Error(`${name} must not contain credentials`);
  return value;
}

function contactEmail(name: string, env: NodeJS.ProcessEnv, production: boolean): string {
  const value = required(name, env);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error(`${name} must be a valid public contact email`);
  if (production && /@(example\.(com|org|net)|example\.(test|invalid)|[^@]+\.invalid)$/i.test(value)) {
    throw new Error(`${name} must not use a placeholder domain in production`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env.NODE_ENV && env.NODE_ENV !== 'development' && env.NODE_ENV !== 'production' && env.NODE_ENV !== 'test') {
    throw new Error('NODE_ENV must be development, test, or production');
  }
  const production = env.NODE_ENV === 'production';
  const appUrl = httpsUrl('APP_ORIGIN', required('APP_ORIGIN', env));
  if (appUrl.pathname !== '/' || appUrl.search || appUrl.hash) throw new Error('APP_ORIGIN must contain only an HTTPS origin');
  if (production && /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(appUrl.hostname)) {
    throw new Error('APP_ORIGIN must be a public host in production');
  }
  const appOrigin = appUrl.origin;
  const redirectUrl = httpsUrl('BUFFER_REDIRECT_URI', required('BUFFER_REDIRECT_URI', env));
  if (redirectUrl.origin !== appOrigin || redirectUrl.pathname !== '/auth/buffer/callback' || redirectUrl.search || redirectUrl.hash) {
    throw new Error('BUFFER_REDIRECT_URI must exactly use APP_ORIGIN plus /auth/buffer/callback');
  }
  const encryptionKey = key('APP_ENCRYPTION_KEY', env);
  const cookieSecret = key('APP_COOKIE_SECRET', env);
  if (encryptionKey.equals(cookieSecret)) throw new Error('APP_ENCRYPTION_KEY and APP_COOKIE_SECRET must be different');
  const databasePath = resolve(env.DATABASE_PATH ?? './data/gabel.db');
  const databaseUrl = env.DATABASE_URL?.trim() || undefined;
  if (databaseUrl) {
    let parsed: URL;
    try { parsed = new URL(databaseUrl); } catch { throw new Error('DATABASE_URL must be a valid PostgreSQL URL'); }
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname) throw new Error('DATABASE_URL must be a valid PostgreSQL URL');
  }
  if (env.VERCEL && !databaseUrl) throw new Error('DATABASE_URL is required for durable Vercel persistence');
  if (production && !databaseUrl && (env.DATABASE_PATH === ':memory:' || databasePath === resolve(':memory:'))) {
    throw new Error('DATABASE_PATH must be persistent in production');
  }
  const operatorName = required('OPERATOR_NAME', env);
  if (production && /^(example|test|todo|tbd|gabel local fixture)/i.test(operatorName)) {
    throw new Error('OPERATOR_NAME must identify the verified production operator');
  }
  const bufferClientId = required('BUFFER_CLIENT_ID', env);
  if (production && /^(example|test|todo|tbd|change[-_ ]?me|local-test-fixture)/i.test(bufferClientId)) {
    throw new Error('BUFFER_CLIENT_ID must identify the registered production Buffer client');
  }
  return {
    appOrigin,
    port: integer('PORT', env.PORT ?? '3443', 1, 65_535),
    bufferClientId,
    bufferClientSecret: env.BUFFER_CLIENT_SECRET?.trim() || undefined,
    bufferRedirectUri: redirectUrl.toString(),
    encryptionKey,
    cookieSecret,
    databasePath,
    databaseUrl,
    tlsKeyPath: env.TLS_KEY_PATH ? resolve(env.TLS_KEY_PATH) : undefined,
    tlsCertPath: env.TLS_CERT_PATH ? resolve(env.TLS_CERT_PATH) : undefined,
    tlsOriginHostname: (() => {
      const hostname = env.TLS_ORIGIN_HOSTNAME?.trim() || appUrl.hostname;
      if (!/^[a-z0-9.-]+$/i.test(hostname) || hostname.length > 253 ||
          hostname.startsWith('.') || hostname.endsWith('.') ||
          hostname.includes('..')) {
        throw new Error('TLS_ORIGIN_HOSTNAME must be a valid DNS hostname');
      }
      return hostname;
    })(),
    requestTimeoutMs: integer('BUFFER_REQUEST_TIMEOUT_MS', env.BUFFER_REQUEST_TIMEOUT_MS ?? '15000', 1_000, 60_000),
    operatorName,
    supportEmail: contactEmail('SUPPORT_EMAIL', env, production),
    privacyEmail: contactEmail('PRIVACY_EMAIL', env, production),
  };
}
