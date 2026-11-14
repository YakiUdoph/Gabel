import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { renderPage } from '../src/views.ts';

test('supplied Gabel logo is a transparent PNG wired to the brand and favicon without distortion', () => {
  const png = readFileSync(new URL('../public/gabel-logo.png', import.meta.url));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 1312);
  assert.equal(png.readUInt32BE(20), 1199);
  assert.equal(png[24], 8);
  assert.equal(png[25], 6);

  const html = renderPage('Logo test', '<h1>Logo test</h1>', { operatorName: 'Test operator', supportEmail: 'support@example.test' });
  assert.match(html, /<link rel="icon" type="image\/png" href="\/gabel-logo\.png">/);
  assert.match(html, /<img class="brand-mark" src="\/gabel-logo\.png" alt="" width="32" height="32"><span class="brand-copy">Gabel<small>Keep scheduled posts ready<\/small>/);
  assert.match(html, /\.brand-mark\{display:block;width:2rem;height:2rem;object-fit:contain;flex:0 0 auto/);

  const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.match(server, /default-src 'none'; img-src 'self'; style-src 'unsafe-inline'/);
  assert.match(server, /url\.pathname === '\/gabel-logo\.png'[\s\S]*?'content-type': 'image\/png'[\s\S]*?req\.method === 'HEAD'/);
});
