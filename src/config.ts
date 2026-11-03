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
  tlsKeyPath?: string;
  tlsCertPath?: string;
  requestTimeoutMs: number;
  operatorName: string;
  supportEmail: string;
  privacyEmail: string;
};

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

export function loadConfig(): Config {
  const appOrigin = required('APP_ORIGIN').replace(/\/$/, '');
  if (!appOrigin.startsWith('https://')) throw new Error('APP_ORIGIN must use HTTPS');
  return {
    appOrigin,
    port: Number(process.env.PORT ?? 3443),
    bufferClientId: required('BUFFER_CLIENT_ID'),
    bufferClientSecret: process.env.BUFFER_CLIENT_SECRET?.trim() || undefined,
    bufferRedirectUri: required('BUFFER_REDIRECT_URI'),
    encryptionKey: key('APP_ENCRYPTION_KEY'),
    cookieSecret: key('APP_COOKIE_SECRET'),
    databasePath: resolve(process.env.DATABASE_PATH ?? './data/gabel.db'),
    tlsKeyPath: process.env.TLS_KEY_PATH ? resolve(process.env.TLS_KEY_PATH) : undefined,
    tlsCertPath: process.env.TLS_CERT_PATH ? resolve(process.env.TLS_CERT_PATH) : undefined,
    requestTimeoutMs: Number(process.env.BUFFER_REQUEST_TIMEOUT_MS ?? 15_000),
    operatorName: required('OPERATOR_NAME'),
    supportEmail: required('SUPPORT_EMAIL'),
    privacyEmail: required('PRIVACY_EMAIL'),
  };
}
