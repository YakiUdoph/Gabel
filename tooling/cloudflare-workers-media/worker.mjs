const ROUTES = new Map([
  ['/original', 'original.png'],
  ['/replacement', 'replacement.png'],
  ['/control', 'control.png'],
]);

const STATES = new Set(['ORIGINAL_AVAILABLE', 'ORIGINAL_REVOKED']);

const NO_STORE_HEADERS = {
  'cache-control': 'no-store, max-age=0',
  'cdn-cache-control': 'no-store',
  expires: '0',
  pragma: 'no-cache',
  'x-content-type-options': 'nosniff',
};

function plain(request, status, message, extra = {}) {
  return new Response(request.method === 'HEAD' ? null : message, {
    status,
    headers: { ...NO_STORE_HEADERS, 'content-type': 'text/plain; charset=utf-8', ...extra },
  });
}

export function createMediaWorker(state) {
  if (!STATES.has(state)) throw new TypeError('Unknown controlled media state');

  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return plain(request, 405, 'Method Not Allowed', { allow: 'GET, HEAD' });
      }
      const key = ROUTES.get(url.pathname);
      if (!key || url.search || url.hash) return plain(request, 404, 'Not Found');
      if (state === 'ORIGINAL_REVOKED' && url.pathname === '/original') {
        return plain(request, 410, 'Gone');
      }

      const assetUrl = new URL(`/${key}`, request.url);
      const asset = await env.ASSETS.fetch(new Request(assetUrl, { method: request.method }));
      if (asset.status !== 200 || asset.headers.has('location')) {
        return plain(request, 500, 'Fixture asset is unavailable');
      }
      const contentType = asset.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
      if (contentType !== 'image/png') {
        return plain(request, 500, 'Fixture asset has an invalid media type');
      }

      const headers = new Headers(NO_STORE_HEADERS);
      headers.set('content-type', 'image/png');
      headers.set('accept-ranges', 'none');
      for (const name of ['content-length', 'etag', 'last-modified']) {
        const value = asset.headers.get(name);
        if (value !== null) headers.set(name, value);
      }
      return new Response(request.method === 'HEAD' ? null : asset.body, { status: 200, headers });
    },
  };
}
