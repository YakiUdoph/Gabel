import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import availableWorker from '../tooling/cloudflare-workers-media/worker.available.mjs';
import revokedWorker from '../tooling/cloudflare-workers-media/worker.revoked.mjs';

const fixtureRoot = new URL('../tooling/cloudflare-workers-media/', import.meta.url);
const assetNames = ['original.png', 'replacement.png', 'control.png'] as const;
type AssetName = typeof assetNames[number];
const routeToAsset = new Map<string, AssetName>([
  ['/original', 'original.png'],
  ['/replacement', 'replacement.png'],
  ['/control', 'control.png'],
]);

function pngBytes(name: AssetName) {
  return readFileSync(new URL(`assets/${name}`, fixtureRoot));
}

function environment(overrides: Partial<Record<AssetName, { body: Uint8Array; contentType: string } | null>> = {}) {
  const calls: string[] = [];
  const entries: Partial<Record<AssetName, { body: Uint8Array; contentType: string } | null>> = Object.fromEntries(
    assetNames.map((name) => [name, { body: pngBytes(name), contentType: 'image/png' }]),
  );
  Object.assign(entries, overrides);
  return {
    calls,
    env: {
      ASSETS: {
        async fetch(request: Request) {
          const name = new URL(request.url).pathname.slice(1) as AssetName;
          calls.push(`${request.method} /${name}`);
          const item = entries[name];
          if (!item) return new Response('Not Found', { status: 404 });
          return new Response(request.method === 'HEAD' ? null : Buffer.from(item.body), {
            status: 200,
            headers: {
              'content-type': item.contentType,
              'content-length': String(item.body.byteLength),
              etag: `"${name}"`,
            },
          });
        },
      },
    },
  };
}

function assertNoStore(response: Response) {
  assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
  assert.equal(response.headers.get('cdn-cache-control'), 'no-store');
  assert.equal(response.headers.get('pragma'), 'no-cache');
  assert.equal(response.headers.get('expires'), '0');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
}

test('all three project assets are genuine, distinct PNG files with the expected dimensions', () => {
  const images = assetNames.map((name) => pngBytes(name));
  for (const bytes of images) {
    assert.deepEqual(bytes.subarray(0, 8), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    assert.equal(bytes.readUInt32BE(16), 1672);
    assert.equal(bytes.readUInt32BE(20), 941);
  }
  assert.notDeepEqual(images[0], images[1]);
  assert.notDeepEqual(images[0], images[2]);
  assert.notDeepEqual(images[1], images[2]);
});

test('ORIGINAL_AVAILABLE serves exact PNG bytes for the three public routes', async () => {
  const { env } = environment();
  for (const [route, assetName] of routeToAsset) {
    const result = await availableWorker.fetch(new Request(`https://media.example${route}`), env);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('content-type'), 'image/png');
    assert.equal(result.headers.get('content-length'), String(pngBytes(assetName).byteLength));
    assert.equal(result.headers.get('location'), null);
    assertNoStore(result);
    assert.deepEqual(Buffer.from(await result.arrayBuffer()), pngBytes(assetName));
  }
});

test('ORIGINAL_REVOKED returns 410 without reading the original while stable routes keep exact bytes', async () => {
  const { env, calls } = environment();
  const original = await revokedWorker.fetch(new Request('https://media.example/original'), env);
  assert.equal(original.status, 410);
  assert.equal(await original.text(), 'Gone');
  assertNoStore(original);
  assert.deepEqual(calls, []);

  for (const [route, assetName] of [['/replacement', 'replacement.png'], ['/control', 'control.png']] as const) {
    const result = await revokedWorker.fetch(new Request(`https://media.example${route}`), env);
    assert.equal(result.status, 200);
    assert.deepEqual(Buffer.from(await result.arrayBuffer()), pngBytes(assetName));
  }
});

test('GET and HEAD have matching status, MIME, length, and headers without a HEAD body', async () => {
  for (const worker of [availableWorker, revokedWorker]) {
    const { env } = environment();
    for (const route of routeToAsset.keys()) {
      const get = await worker.fetch(new Request(`https://media.example${route}`), env);
      const head = await worker.fetch(new Request(`https://media.example${route}`, { method: 'HEAD' }), env);
      assert.equal(head.status, get.status);
      assert.equal(head.headers.get('content-type'), get.headers.get('content-type'));
      assert.equal(head.headers.get('content-length'), get.headers.get('content-length'));
      assertNoStore(head);
      assert.equal(await head.text(), '');
    }
  }
});

test('unknown, raw-asset, query, and public state-changing paths are explicit 404 responses', async () => {
  const { env } = environment();
  for (const path of ['/other', '/original.png', '/assets/original.png', '/admin', '/revoke', '/toggle', '/state', '/original?state=revoked']) {
    const response = await availableWorker.fetch(new Request(`https://media.example${path}`), env);
    assert.equal(response.status, 404, path);
    assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
    assertNoStore(response);
  }
});

test('every unsupported method receives 405 and cannot change state', async () => {
  const { env, calls } = environment();
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const response = await availableWorker.fetch(new Request('https://media.example/original', { method }), env);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
    assertNoStore(response);
  }
  assert.deepEqual(calls, []);
});

test('missing, redirected, or incorrectly typed bundled assets fail closed', async () => {
  const missing = environment({ 'original.png': null });
  assert.equal((await availableWorker.fetch(new Request('https://media.example/original'), missing.env)).status, 500);

  const invalid = environment({ 'original.png': { body: pngBytes('original.png'), contentType: 'text/html' } });
  assert.equal((await availableWorker.fetch(new Request('https://media.example/original'), invalid.env)).status, 500);

  const redirected = { ASSETS: { fetch: async () => new Response(null, { status: 302, headers: { location: '/original.png' } }) } };
  assert.equal((await availableWorker.fetch(new Request('https://media.example/original'), redirected)).status, 500);
});

test('both deployment configurations force Worker-first static assets and exclude R2, KV, and custom domains', () => {
  for (const [filename, main] of [['wrangler.available.jsonc', 'worker.available.mjs'], ['wrangler.revoked.jsonc', 'worker.revoked.mjs']] as const) {
    const source = readFileSync(new URL(filename, fixtureRoot), 'utf8');
    const config = JSON.parse(source) as Record<string, unknown> & { assets: Record<string, unknown>; cache: Record<string, unknown> };
    assert.equal(config.main, main);
    assert.equal(config.workers_dev, true);
    assert.equal(config.preview_urls, false);
    assert.equal(config.cache.enabled, false);
    assert.equal(config.assets.directory, './assets');
    assert.equal(config.assets.binding, 'ASSETS');
    assert.equal(config.assets.run_worker_first, true);
    assert.equal(config.assets.html_handling, 'none');
    assert.equal(config.assets.not_found_handling, 'none');
    assert.doesNotMatch(source, /r2_buckets|kv_namespaces|routes|custom_domains|bucket_name/i);
  }
});

test('fixture code has no storage mutation, cache API, logging, analytics, R2, or KV dependency', () => {
  const files = ['worker.mjs', 'worker.available.mjs', 'worker.revoked.mjs'];
  const source = files.map((name) => readFileSync(new URL(name, fixtureRoot), 'utf8')).join('\n');
  assert.doesNotMatch(source, /\bcaches\b|console\.|analytics|\.put\(|\.delete\(|TEST_MEDIA|\bR2\b|\bKV\b/i);
  assert.match(source, /env\.ASSETS\.fetch/);
  assert.match(source, /ORIGINAL_AVAILABLE/);
  assert.match(source, /ORIGINAL_REVOKED/);
});
