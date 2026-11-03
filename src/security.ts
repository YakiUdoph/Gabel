import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');
export const sha256 = (value: string): string => createHash('sha256').update(value).digest('base64url');
export const pkceChallenge = (verifier: string): string => sha256(verifier);

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function encrypt(value: string, encryptionKey: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString('base64url')).join('.');
}

export function decrypt(value: string, encryptionKey: Buffer): string {
  const [ivPart, tagPart, dataPart] = value.split('.');
  if (!ivPart || !tagPart || !dataPart) throw new Error('Invalid encrypted value');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(ivPart, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataPart, 'base64url')), decipher.final()]).toString('utf8');
}

export function signCookie(value: string, secret: Buffer): string {
  const signature = createHmac('sha256', secret).update(value).digest('base64url');
  return `${value}.${signature}`;
}

export function verifyCookie(signed: string | undefined, secret: Buffer): string | undefined {
  if (!signed) return undefined;
  const index = signed.lastIndexOf('.');
  if (index < 1) return undefined;
  const value = signed.slice(0, index);
  const signature = signed.slice(index + 1);
  const expected = createHmac('sha256', secret).update(value).digest('base64url');
  return safeEqual(signature, expected) ? value : undefined;
}

const SECRET_KEY_PATTERN = /^(access_token|refresh_token|client_secret|authorization|code_verifier)$/i;
export function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      SECRET_KEY_PATTERN.test(key) ? '[REDACTED]' : sanitize(item),
    ]));
  }
  return value;
}

export function evidencePost(value: { id?: string; channelId?: string; status?: string; dueAt?: string | null; shareMode?: string; schedulingType?: string | null; text?: string; assets?: Array<{ type?: string; mimeType?: string; source?: string }> }): unknown {
  return {
    postIdHash: value.id ? sha256(value.id) : undefined,
    channelIdHash: value.channelId ? sha256(value.channelId) : undefined,
    status: value.status,
    dueAt: value.dueAt,
    shareMode: value.shareMode,
    schedulingType: value.schedulingType,
    textHash: value.text == null ? undefined : sha256(value.text),
    assets: value.assets?.map((asset) => ({
      type: asset.type,
      mimeType: asset.mimeType,
      sourceHash: asset.source ? sha256(asset.source) : undefined,
    })),
  };
}
