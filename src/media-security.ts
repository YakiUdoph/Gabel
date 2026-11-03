import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

export type AddressResolver = (hostname: string) => Promise<string[]>;
export type MediaFormat = 'jpeg' | 'png' | 'gif' | 'webp' | 'unknown';
export type ImageDimensions = { width: number; height: number };
export type MediaResponse = {
  status: number;
  location?: string;
  contentType?: string;
  contentLength?: number;
  fileSizeBytes?: number;
  signature?: Uint8Array;
  dimensions?: ImageDimensions;
  inspectionDigest?: string;
};
export type PinnedMediaRequester = (url: URL, address: string, timeoutMs: number) => Promise<MediaResponse>;
export type MediaProbeResult = {
  outcome: 'reachable' | 'unreachable' | 'unsafe' | 'error';
  httpStatus?: number;
  contentType?: string;
  contentLength?: number;
  fileSizeBytes?: number;
  declaredFormat?: MediaFormat;
  detectedFormat?: MediaFormat;
  dimensions?: ImageDimensions;
  inspectionDigest?: string;
  dnsLookups: number;
  resolvedAddressCount: number;
  addressFamilies: number[];
  allAddressesPublic: boolean;
  redirects: number;
  reason: string;
  errorCategory?: 'dns' | 'network' | 'tls' | 'timeout' | 'dns_pinning_callback' | 'other';
  durationMs: number;
};

export type PublicMediaStatus = {
  label: 'CONFIRMED PROBLEM' | 'COULD NOT VERIFY' | 'UNSUPPORTED FILE' | 'READY';
  detail: string;
};

export function publicMediaStatus(result: MediaProbeResult): PublicMediaStatus {
  if (result.outcome === 'error') {
    return { label: 'COULD NOT VERIFY', detail: 'Gabel could not complete the network check. The file may still be available.' };
  }
  if (result.outcome === 'unsafe') {
    return { label: 'COULD NOT VERIFY', detail: 'Gabel did not connect because the destination did not pass the safety check.' };
  }
  if (result.outcome === 'unreachable') {
    if (result.httpStatus != null && result.httpStatus >= 400) {
      return { label: 'CONFIRMED PROBLEM', detail: `The remote server returned HTTP ${result.httpStatus}.` };
    }
    return { label: 'COULD NOT VERIFY', detail: 'Gabel did not receive a usable file response.' };
  }
  const kind = classifyMediaContentType(result.contentType);
  if (kind === 'unsupported' || kind === 'unknown') {
    return { label: 'UNSUPPORTED FILE', detail: 'The server responded, but the file type is not supported.' };
  }
  if (kind === 'image' && (result.declaredFormat === 'unknown' || result.detectedFormat === 'unknown'
    || result.declaredFormat !== result.detectedFormat)) {
    return { label: 'UNSUPPORTED FILE', detail: 'The server responded, but the image type did not match the file header.' };
  }
  return { label: 'READY', detail: 'The server responded and the checks Gabel performed passed.' };
}

const defaultResolver: AddressResolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

class MediaPolicyError extends Error {}

export function mediaErrorCategory(error: unknown): NonNullable<MediaProbeResult['errorCategory']> {
  const candidate = error as { code?: unknown; cause?: { code?: unknown } };
  const code = typeof candidate?.code === 'string' ? candidate.code
    : typeof candidate?.cause?.code === 'string' ? candidate.cause.code : '';
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return 'dns';
  if (code.includes('CERT') || code.includes('TLS')) return 'tls';
  if (code.includes('TIMEOUT') || code === 'ETIMEDOUT') return 'timeout';
  if (code === 'ERR_INVALID_IP_ADDRESS') return 'dns_pinning_callback';
  if (['ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH'].includes(code)) return 'network';
  return 'other';
}

export function classifyMediaContentType(contentType: string | undefined): 'image' | 'video' | 'document' | 'unsupported' | 'unknown' {
  const normalized = contentType?.split(';', 1)[0].trim().toLowerCase();
  if (!normalized) return 'unknown';
  if (normalized.startsWith('image/')) return 'image';
  if (normalized.startsWith('video/')) return 'video';
  if (normalized === 'application/pdf') return 'document';
  return 'unsupported';
}

export function mediaFormatFromContentType(contentType: string | undefined): MediaFormat {
  const normalized = contentType?.split(';', 1)[0].trim().toLowerCase();
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return 'jpeg';
  if (normalized === 'image/png') return 'png';
  if (normalized === 'image/gif') return 'gif';
  if (normalized === 'image/webp') return 'webp';
  return 'unknown';
}

export function detectImageSignature(bytes: Uint8Array | undefined): MediaFormat {
  if (!bytes) return 'unknown';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)) return 'png';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(Buffer.from(bytes.subarray(0, 6)).toString('ascii'))) return 'gif';
  if (bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF'
    && Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP') return 'webp';
  return 'unknown';
}

export function detectImageDimensions(bytes: Uint8Array | undefined, format = detectImageSignature(bytes)): ImageDimensions | undefined {
  if (!bytes) return undefined;
  if (format === 'png' && bytes.length >= 24) {
    const buffer = Buffer.from(bytes);
    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    return width > 0 && height > 0 ? { width, height } : undefined;
  }
  if (format === 'gif' && bytes.length >= 10) {
    const width = bytes[6] | (bytes[7] << 8);
    const height = bytes[8] | (bytes[9] << 8);
    return width > 0 && height > 0 ? { width, height } : undefined;
  }
  if (format !== 'jpeg' || bytes.length < 4) return undefined;
  const startOfFrameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 3 < bytes.length) {
    while (offset < bytes.length && bytes[offset] !== 0xff) offset++;
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    if (offset >= bytes.length) return undefined;
    const marker = bytes[offset];
    if (marker === 0xd9 || marker === 0xda) return undefined;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset++;
      continue;
    }
    if (offset + 2 >= bytes.length) return undefined;
    const segmentLength = (bytes[offset + 1] << 8) | bytes[offset + 2];
    if (segmentLength < 2) return undefined;
    if (startOfFrameMarkers.has(marker)) {
      if (offset + 7 >= bytes.length) return undefined;
      const height = (bytes[offset + 4] << 8) | bytes[offset + 5];
      const width = (bytes[offset + 6] << 8) | bytes[offset + 7];
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    offset += 1 + segmentLength;
  }
  return undefined;
}

type PinnedLookupCallback = (error: null, result: string | Array<{ address: string; family: number }>, family?: number) => void;
export function returnPinnedLookup(address: string, all: boolean, callback: PinnedLookupCallback): void {
  const family = isIP(address);
  if (all) callback(null, [{ address, family }]);
  else callback(null, address, family);
}

function ipv4Number(address: string): number {
  return address.split('.').reduce((value, part) => (value * 256) + Number(part), 0) >>> 0;
}

function inV4Range(address: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4Number(address) & mask) === (ipv4Number(base) & mask);
}

export function isProhibitedNetworkAddress(address: string): boolean {
  if (isIP(address) === 4) {
    return [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
      ['224.0.0.0', 4], ['240.0.0.0', 4],
    ].some(([base, bits]) => inV4Range(address, String(base), Number(bits)));
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith('::ffff:')) return isProhibitedNetworkAddress(normalized.slice(7));
    return normalized === '::' || normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd')
      || /^fe[89ab]/.test(normalized) || normalized.startsWith('ff') || normalized.startsWith('2001:db8:');
  }
  return true;
}

async function resolvePublicMediaUrl(raw: string, resolver: AddressResolver): Promise<{ url: URL; addresses: string[] }> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new MediaPolicyError('Media URL is invalid'); }
  if (url.protocol !== 'https:') throw new MediaPolicyError('Media URL must use HTTPS');
  if (url.username || url.password) throw new MediaPolicyError('Media URL must not contain credentials');
  if (url.port && url.port !== '443') throw new MediaPolicyError('Media URL must use the standard HTTPS port');
  const rawHostname = url.hostname.toLowerCase().replace(/\.$/, '');
  const hostname = rawHostname.startsWith('[') && rawHostname.endsWith(']') ? rawHostname.slice(1, -1) : rawHostname;
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new MediaPolicyError('Media URL destination is prohibited');
  }
  const addresses = isIP(hostname) ? [hostname] : await resolver(hostname);
  if (!addresses.length || addresses.some(isProhibitedNetworkAddress)) throw new MediaPolicyError('Media URL resolves to a prohibited destination');
  return { url, addresses };
}

export async function validatePublicMediaUrl(raw: string, resolver: AddressResolver = defaultResolver): Promise<URL> {
  return (await resolvePublicMediaUrl(raw, resolver)).url;
}

export async function validateMediaRedirect(from: URL, location: string, resolver: AddressResolver = defaultResolver): Promise<URL> {
  return validatePublicMediaUrl(new URL(location, from).toString(), resolver);
}

const defaultRequester: PinnedMediaRequester = (url, address, timeoutMs) => new Promise((resolve, reject) => {
  const inspectionLimit = 64 * 1024;
  const fingerprintLimit = 4 * 1024;
  const tlsHostname = url.hostname.startsWith('[') && url.hostname.endsWith(']') ? url.hostname.slice(1, -1) : url.hostname;
  const request = httpsRequest({
    protocol: 'https:', hostname: tlsHostname, port: 443, path: `${url.pathname}${url.search}`,
    method: 'GET', servername: isIP(tlsHostname) ? undefined : tlsHostname, maxHeaderSize: 16 * 1024,
    headers: { accept: '*/*', range: `bytes=0-${inspectionLimit - 1}`, 'user-agent': 'Gabel-Media-Check/0.1' },
    lookup: (_hostname, options, callback) => {
      returnPinnedLookup(address, Boolean(typeof options === 'object' && options.all), callback as unknown as PinnedLookupCallback);
    },
  }, (response) => {
    const rawLength = response.headers['content-length'];
    const contentLength = typeof rawLength === 'string' && /^\d+$/.test(rawLength) ? Number(rawLength) : undefined;
    const rawType = response.headers['content-type'];
    const contentType = typeof rawType === 'string' ? rawType.slice(0, 200) : undefined;
    const rawLocation = response.headers.location;
    const rawRange = response.headers['content-range'];
    const rangeMatch = typeof rawRange === 'string' ? rawRange.match(/^bytes\s+\d+-\d+\/(\d+|\*)$/i) : null;
    const rangeTotal = rangeMatch?.[1] && rangeMatch[1] !== '*' ? Number(rangeMatch[1]) : undefined;
    const fileSizeBytes = Number.isSafeInteger(rangeTotal) ? rangeTotal
      : response.statusCode === 200 && Number.isSafeInteger(contentLength) ? contentLength : undefined;
    const base = { status: response.statusCode ?? 0, location: rawLocation, contentType, contentLength, fileSizeBytes };
    if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
      response.destroy();
      resolve(base);
      return;
    }
    let settled = false;
    const chunks: Buffer[] = [];
    let inspectedBytes = 0;
    const finish = () => {
      if (settled) return;
      settled = true;
      response.destroy();
      const inspected = Buffer.concat(chunks, inspectedBytes);
      const signature = inspected.length ? inspected.subarray(0, 16) : undefined;
      const fingerprintBytes = inspected.subarray(0, Math.min(inspected.length, fingerprintLimit));
      resolve({ ...base, signature, dimensions: detectImageDimensions(inspected),
        inspectionDigest: fingerprintBytes.length ? createHash('sha256').update(fingerprintBytes).digest('base64url') : undefined });
    };
    response.on('data', (chunk: Buffer) => {
      const remaining = inspectionLimit - inspectedBytes;
      if (remaining > 0) {
        const retained = chunk.subarray(0, remaining);
        chunks.push(retained);
        inspectedBytes += retained.length;
      }
      const inspected = Buffer.concat(chunks, inspectedBytes);
      if ((detectImageDimensions(inspected) && inspectedBytes >= fingerprintLimit) || inspectedBytes >= inspectionLimit) finish();
    });
    response.once('end', finish);
    response.once('error', reject);
  });
  request.setTimeout(timeoutMs, () => request.destroy(Object.assign(new Error('Media check timed out'), { code: 'ETIMEDOUT' })));
  request.once('error', reject);
  request.end();
});

export async function probeMediaUrl(raw: string, options: {
  resolver?: AddressResolver;
  requester?: PinnedMediaRequester;
  timeoutMs?: number;
  maxRedirects?: number;
} = {}): Promise<MediaProbeResult> {
  const resolver = options.resolver ?? defaultResolver;
  const requester = options.requester ?? defaultRequester;
  const timeoutMs = Math.min(Math.max(options.timeoutMs ?? 5_000, 500), 15_000);
  const maxRedirects = Math.min(Math.max(options.maxRedirects ?? 3, 0), 5);
  let current = raw;
  let redirects = 0;
  let dnsLookups = 0;
  let resolvedAddressCount = 0;
  const addressFamilies = new Set<number>();
  const started = performance.now();
  const finish = (result: Omit<MediaProbeResult, 'durationMs' | 'dnsLookups' | 'resolvedAddressCount' | 'addressFamilies' | 'allAddressesPublic'>): MediaProbeResult =>
    ({ ...result, dnsLookups, resolvedAddressCount, addressFamilies: [...addressFamilies].sort(),
      allAddressesPublic: resolvedAddressCount > 0, durationMs: Math.round(performance.now() - started) });

  for (;;) {
    let resolved: { url: URL; addresses: string[] };
    try {
      resolved = await resolvePublicMediaUrl(current, resolver);
      dnsLookups++;
      resolvedAddressCount += resolved.addresses.length;
      for (const address of resolved.addresses) addressFamilies.add(isIP(address));
    } catch (error) {
      if (error instanceof MediaPolicyError) return finish({ outcome: 'unsafe', redirects, reason: error.message });
      return finish({ outcome: 'error', redirects, errorCategory: 'dns', reason: 'Media hostname could not be resolved' });
    }
    let response: MediaResponse;
    try {
      response = await requester(resolved.url, resolved.addresses[0], timeoutMs);
    } catch (error) {
      const errorCategory = mediaErrorCategory(error);
      const reason = errorCategory === 'tls' ? 'Media host TLS verification failed'
        : errorCategory === 'timeout' ? 'Media host did not respond within the timeout'
        : errorCategory === 'dns_pinning_callback' ? 'Pinned DNS result could not be applied'
        : 'Media host could not be reached within the safety limits';
      return finish({ outcome: 'error', redirects, errorCategory, reason });
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.location) return finish({ outcome: 'unreachable', httpStatus: response.status, redirects, reason: 'Redirect response omitted a destination' });
      if (redirects >= maxRedirects) return finish({ outcome: 'unreachable', httpStatus: response.status, redirects, reason: 'Media URL exceeded the redirect limit' });
      try {
        current = new URL(response.location, resolved.url).toString();
      } catch {
        return finish({ outcome: 'unsafe', httpStatus: response.status, redirects, reason: 'Redirect destination was invalid' });
      }
      redirects++;
      continue;
    }
    const details = { httpStatus: response.status, contentType: response.contentType, contentLength: response.contentLength,
      fileSizeBytes: response.fileSizeBytes, declaredFormat: mediaFormatFromContentType(response.contentType),
      detectedFormat: detectImageSignature(response.signature), dimensions: response.dimensions,
      inspectionDigest: response.inspectionDigest, redirects };
    if (response.status >= 200 && response.status < 300) return finish({ outcome: 'reachable', ...details, reason: 'Media host returned a successful response' });
    return finish({ outcome: 'unreachable', ...details, reason: `Media host returned HTTP ${response.status || 'unknown'}` });
  }
}
