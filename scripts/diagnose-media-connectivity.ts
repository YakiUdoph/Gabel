import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { classifyMediaContentType, isProhibitedNetworkAddress, probeMediaUrl, returnPinnedLookup } from '../src/media-security.ts';

const endpoints = [
  { label: 'w3c_png', url: 'https://www.w3.org/Icons/w3c_home.png' },
  { label: 'httpbin_jpeg', url: 'https://httpbin.org/image/jpeg' },
  { label: 'placeholder_png', url: 'https://placehold.co/32x32.png' },
  { label: 'unsupported_html_control', url: 'https://example.com/' },
  { label: 'expired_tls_control', url: 'https://expired.badssl.com/favicon.ico' },
];

function errorCode(error: unknown): string {
  const candidate = error as { code?: unknown; cause?: { code?: unknown } };
  return typeof candidate?.code === 'string' ? candidate.code
    : typeof candidate?.cause?.code === 'string' ? candidate.cause.code : 'UNKNOWN';
}

function category(code: string): string {
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return 'dns';
  if (code.includes('CERT') || code.includes('TLS')) return 'tls';
  if (code.includes('TIMEOUT') || code === 'ETIMEDOUT') return 'timeout';
  if (['ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH'].includes(code)) return 'network';
  if (code === 'ERR_INVALID_IP_ADDRESS') return 'dns_pinning_callback';
  return 'other';
}

async function directFetch(url: string): Promise<Record<string, unknown>> {
  const started = performance.now();
  try {
    const response = await fetch(url, { headers: { range: 'bytes=0-0', accept: '*/*' }, signal: AbortSignal.timeout(8_000) });
    await response.body?.cancel();
    const contentType = response.headers.get('content-type')?.slice(0, 100);
    return { ok: true, status: response.status, contentType, mediaFormat: classifyMediaContentType(contentType),
      durationMs: Math.round(performance.now() - started) };
  } catch (error) {
    const code = errorCode(error);
    return { ok: false, errorCategory: category(code), errorCode: code, durationMs: Math.round(performance.now() - started) };
  }
}

async function reproducePinnedLookup(url: URL, address: string): Promise<Record<string, unknown>> {
  const started = performance.now();
  let lookupRequestedAll = false;
  try {
    await new Promise<void>((resolve, reject) => {
      const request = httpsRequest({
        protocol: 'https:', hostname: url.hostname, port: 443, path: `${url.pathname}${url.search}`, method: 'GET',
        servername: url.hostname, headers: { range: 'bytes=0-0', accept: '*/*' }, maxHeaderSize: 16 * 1024,
        lookup: (_hostname, options, callback) => {
          lookupRequestedAll = Boolean(typeof options === 'object' && options.all);
          returnPinnedLookup(address, lookupRequestedAll, callback as never);
        },
      }, (response) => { response.destroy(); resolve(); });
      request.setTimeout(8_000, () => request.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
      request.once('error', reject);
      request.end();
    });
    return { ok: true, lookupRequestedAll, durationMs: Math.round(performance.now() - started) };
  } catch (error) {
    const code = errorCode(error);
    return { ok: false, lookupRequestedAll, errorCategory: category(code), errorCode: code,
      durationMs: Math.round(performance.now() - started) };
  }
}

const results = [];
for (const endpoint of endpoints) {
  const url = new URL(endpoint.url);
  const dnsStarted = performance.now();
  try {
    const addresses = await lookup(url.hostname, { all: true, verbatim: true });
    const dns = { ok: addresses.length > 0, answerCount: addresses.length,
      families: [...new Set(addresses.map((entry) => entry.family))].sort(),
      allPublic: addresses.length > 0 && addresses.every((entry) => !isProhibitedNetworkAddress(entry.address)),
      durationMs: Math.round(performance.now() - dnsStarted) };
    const direct = await directFetch(endpoint.url);
    const gabelStarted = performance.now();
    const gabel = await probeMediaUrl(endpoint.url, { timeoutMs: 8_000 });
    const gabelDiagnostic = { ...gabel, mediaFormat: classifyMediaContentType(gabel.contentType),
      durationMs: Math.round(performance.now() - gabelStarted) };
    const pinnedReproduction = dns.allPublic ? await reproducePinnedLookup(url, addresses[0].address) : { skipped: true };
    results.push({ endpoint: endpoint.label, dns, direct, gabel: gabelDiagnostic, pinnedReproduction });
  } catch (error) {
    const code = errorCode(error);
    results.push({ endpoint: endpoint.label, dns: { ok: false, errorCategory: category(code), errorCode: code,
      durationMs: Math.round(performance.now() - dnsStarted) } });
  }
}

console.log(JSON.stringify({ executedAt: new Date().toISOString(), results }, null, 2));
