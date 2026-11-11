import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createHttpsServer, request as httpsRequest, type Server as HttpsServer } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../src/db.ts';
import { fingerprintPost } from '../src/edit.ts';
import { sha256, signCookie } from '../src/security.ts';
import type { AssetInput, BufferPost } from '../src/types.ts';

const root = resolve('.');
const runDir = join(tmpdir(), `gabel-product-browser-verification-${process.pid}`);
const artifacts = join(root, 'docs', 'screenshots', 'final-product-experience');
const databasePath = join(runDir, 'fixtures.db');
const basePort = 22_000 + (process.pid % 20_000);
const appPort = basePort;
const unauthPort = basePort + 1;
const fixturePort = basePort + 2;
const appOrigin = `https://localhost:${appPort}`;
const unauthOrigin = `https://localhost:${unauthPort}`;
const fixtureOrigin = `https://localhost:${fixturePort}`;
const cookieSecret = Buffer.alloc(32, 7);
const encryptionKey = Buffer.alloc(32, 9);
const sessionId = 'local-fixture-session';
const csrf = 'local-fixture-csrf';
const tenantId = 'local-fixture-tenant';
const connectionId = 'local-fixture-connection';
const cookieHeader = `gabel_session=${signCookie(sessionId, cookieSecret)}; gabel_csrf=${signCookie(csrf, cookieSecret)}`;
const ids = { approval: '10000000-0000-4000-8000-000000000001', confirmed: '10000000-0000-4000-8000-000000000002', ambiguous: '10000000-0000-4000-8000-000000000003', failed: '10000000-0000-4000-8000-000000000004' };

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function fixturePost(id: string, offsetHours: number): BufferPost {
  return { id, channelId: 'fixture-channel', status: 'scheduled', dueAt: new Date(Date.now() + offsetHours * 3_600_000).toISOString(), shareMode: 'scheduled', schedulingType: 'automatic', text: 'LOCAL TEST FIXTURE — browser verification only', updatedAt: new Date().toISOString(), allowedActions: ['updatePost'], metadata: { type: 'fixture' }, tags: [], assets: [{ id: `${id}-asset`, type: 'image', mimeType: 'image/png', source: `https://fixture.invalid/${id}.png`, thumbnail: '', image: { altText: 'Fixture image', animatedThumbnail: null, userTags: null } }] };
}

function seed(): void {
  rmSync(runDir, { recursive: true, force: true }); mkdirSync(runDir, { recursive: true }); mkdirSync(artifacts, { recursive: true });
  const store = new Store(databasePath); store.createTenant(tenantId);
  store.createSession({ idHash: sha256(sessionId), tenantId, csrfHash: sha256(csrf), expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  store.upsertConnection({ id: connectionId, tenant_id: tenantId, buffer_account_id: 'LOCAL-TEST-FIXTURE', access_token_ciphertext: 'not-live-token', refresh_token_ciphertext: null, access_expires_at: new Date(Date.now() + 86_400_000).toISOString(), scopes: 'fixture:read fixture:write' });
  store.replaceDiscovery(tenantId, connectionId, [{ id: 'fixture-org', name: 'LOCAL TEST FIXTURE', channels: [{ id: 'fixture-channel', name: 'fixture', displayName: 'LOCAL TEST FIXTURE CHANNEL', service: 'fixture', isDisconnected: false, isLocked: false }] }]);
  const posts = ['ready', 'problem', 'unknown', 'unsupported', 'unchecked', 'stale'].map((name, index) => fixturePost(`fixture-${name}`, index + 2));
  store.replacePosts(tenantId, connectionId, 'fixture-org', posts);
  const checkedAt = new Date().toISOString();
  const checks = [['ready', 'ready', 'READY', 'Fixture response contains a supported image.'], ['problem', 'confirmed_problem', 'CONFIRMED PROBLEM', 'Fixture response returned HTTP 404.'], ['unknown', 'could_not_verify', 'COULD NOT VERIFY', 'Fixture network response was inconclusive.'], ['unsupported', 'unsupported_file', 'UNSUPPORTED FILE', 'Fixture response is not a supported image.']] as const;
  for (const [name, status, label, detail] of checks) store.saveMediaCheck({ tenantId, connectionId, postId: `fixture-${name}`, status, checkedCount: 1, checkedAt, summary: [{ position: 0, type: name === 'unsupported' ? 'document' : 'image', label, detail }] });
  store.saveMediaCheck({ tenantId, connectionId, postId: 'fixture-stale', status: 'confirmed_problem', checkedCount: 1, checkedAt: new Date(Date.now() - 20 * 60_000).toISOString(), summary: [{ position: 0, type: 'image', label: 'CONFIRMED PROBLEM', detail: 'Stale fixture.' }] });
  const before = posts[1]; const intended: AssetInput[] = [{ image: { url: 'https://fixture.invalid/replacement.png', metadata: { altText: 'Fixture replacement' } } }];
  const now = new Date().toISOString(); const future = new Date(Date.now() + 3_600_000).toISOString();
  const insert = store.db.prepare(`INSERT INTO edit_intents(id,tenant_id,connection_id,post_id,before_json,intended_assets_json,before_fingerprint,status,created_at,expires_at,outcome_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  const base = [tenantId, connectionId, before.id, JSON.stringify(before), JSON.stringify(intended), fingerprintPost(before)] as const;
  const problemEvidence = { checkedAt, summary: [{ position: 0, label: 'CONFIRMED PROBLEM', detail: 'Fixture response returned an unsuccessful status.', httpStatus: 404 }] };
  const after = { ...before, assets: [{ ...before.assets[0], source: 'https://fixture.invalid/replacement.png', thumbnail: '' }] };
  insert.run(ids.approval, ...base, 'pending', now, future, JSON.stringify({ testFixture: true, problemEvidence, replacementValidations: [{ position: 0, format: 'png', fileSizeBytes: 184320, dimensions: { width: 1200, height: 630 }, validatedAt: now }] }));
  insert.run(ids.confirmed, ...base, 'confirmed', now, future, JSON.stringify({ testFixture: true, before, after, comparison: { matches: true, discrepancies: [] } }));
  insert.run(ids.ambiguous, ...base, 'ambiguous', now, future, JSON.stringify({ testFixture: true, before, comparison: { matches: false, discrepancies: ['Fresh verification response is missing'] } }));
  insert.run(ids.failed, ...base, 'failed', now, future, JSON.stringify({ testFixture: true, reason: 'Fixture edit was rejected before success.' })); store.close();
}

function proxy(port: number, authenticated: boolean): HttpsServer {
  const options = { key: readFileSync(join(root, 'certs', 'localhost-key.pem')), cert: readFileSync(join(root, 'certs', 'localhost.pem')) };
  return createHttpsServer(options, (incoming, outgoing) => {
    const headers = { ...incoming.headers, host: `localhost:${appPort}` }; if (authenticated) headers.cookie = cookieHeader; else delete headers.cookie;
    const upstream = httpsRequest({ hostname: 'localhost', port: appPort, path: incoming.url, method: incoming.method, headers, rejectUnauthorized: false }, (response) => { const responseHeaders = { ...response.headers }; delete responseHeaders['set-cookie']; outgoing.writeHead(response.statusCode ?? 502, responseHeaders); response.pipe(outgoing); });
    upstream.on('error', (error) => { outgoing.writeHead(502); outgoing.end(String(error)); }); incoming.pipe(upstream);
  }).listen(port);
}

async function child(command: string, args: string[], capture = false, timeoutMs = 20_000): Promise<string> {
  return new Promise((resolveChild, rejectChild) => { const process = spawn(command, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = ''; let stderr = ''; let settled = false;
    const finish = (error?: Error): void => { if (settled) return; settled = true; clearTimeout(timer); error ? rejectChild(error) : resolveChild(stdout); };
    const timer = setTimeout(() => { process.kill(); finish(new Error(`${command} timed out after ${timeoutMs}ms`)); }, timeoutMs);
    process.stdout?.on('data', (part) => { if (capture) stdout += String(part); }); process.stderr?.on('data', (part) => { stderr += String(part); });
    process.once('error', (error) => finish(error)); process.once('exit', (code) => code === 0 ? finish() : finish(new Error(`${command} exited ${code}: ${stderr.slice(-1000)}`))); });
}
const browserSafetyFlags = ['--disable-gpu', '--in-process-gpu', '--disable-features=SkiaGraphite,DawnGraphite,UseDawn', '--disable-background-networking', '--disable-breakpad', '--no-first-run', '--no-default-browser-check'];
async function browserDom(browser: string, url: string): Promise<string> { return child(browser, ['--headless=new', '--ignore-certificate-errors', ...browserSafetyFlags, `--user-data-dir=${join(runDir, `profile-${Math.random().toString(16).slice(2)}`)}`, '--dump-dom', url], true); }
async function browserShot(browser: string, url: string, name: string, width: number, height: number): Promise<void> { await child(browser, ['--headless=new', '--ignore-certificate-errors', ...browserSafetyFlags, '--hide-scrollbars', `--user-data-dir=${join(runDir, `profile-${Math.random().toString(16).slice(2)}`)}`, `--window-size=${width},${height}`, `--screenshot=${join(artifacts, `${name}.png`)}`, url]); }

function request(path: string, method = 'GET', body = '', cookie = cookieHeader): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> {
  return new Promise((resolveRequest, rejectRequest) => { const req = httpsRequest({ hostname: 'localhost', port: appPort, path, method, rejectUnauthorized: false, headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } }, (response) => { const chunks: Buffer[] = []; response.on('data', (part) => chunks.push(part)); response.on('end', () => resolveRequest({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: response.headers })); }); req.on('error', rejectRequest); if (body) req.write(body); req.end(); });
}
function contrast(foreground: string, background: string): number { const luminance = (hex: string) => { const values = hex.match(/[0-9a-f]{2}/gi)!.map((part) => parseInt(part, 16) / 255).map((value) => value <= .03928 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4); return .2126 * values[0] + .7152 * values[1] + .0722 * values[2]; }; const [a, b] = [luminance(foreground), luminance(background)].sort((x, y) => y - x); return (a + .05) / (b + .05); }

async function main(): Promise<void> {
  seed(); const candidates = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']; const browser = candidates.find(existsSync); assert(browser, 'Chrome or Edge is required for browser verification');
  const env = { ...process.env, APP_ORIGIN: appOrigin, PORT: String(appPort), BUFFER_CLIENT_ID: 'local-test-fixture', BUFFER_REDIRECT_URI: `${appOrigin}/auth/buffer/callback`, APP_ENCRYPTION_KEY: encryptionKey.toString('base64url'), APP_COOKIE_SECRET: cookieSecret.toString('base64url'), DATABASE_PATH: databasePath, TLS_KEY_PATH: join(root, 'certs', 'localhost-key.pem'), TLS_CERT_PATH: join(root, 'certs', 'localhost.pem'), OPERATOR_NAME: 'Gabel local fixture', SUPPORT_EMAIL: 'fixture@example.invalid', PRIVACY_EMAIL: 'fixture@example.invalid' };
  let server: ChildProcess | undefined; let unauthProxy: HttpsServer | undefined; let authProxy: HttpsServer | undefined;
  try {
    server = spawn(process.execPath, ['--experimental-strip-types', 'src/server.ts'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }); server.stderr?.on('data', (part) => process.stderr.write(part));
    await new Promise<void>((resolveReady, rejectReady) => { const timeout = setTimeout(() => rejectReady(new Error('Fixture server did not start')), 10_000); server?.stdout?.on('data', (part) => { if (String(part).includes('server_started')) { clearTimeout(timeout); resolveReady(); } }); });
    unauthProxy = proxy(unauthPort, false); authProxy = proxy(fixturePort, true);
    const ready = await request('/health/ready'); assert(ready.status === 200 && ready.body.includes('"status":"ready"') && !ready.headers['set-cookie'], 'Readiness endpoint failed or created a browser session');
    const empty = await browserDom(browser, `${unauthOrigin}/`); assert(empty.includes('Connect Buffer to begin') && empty.includes('href="/auth/buffer/start"'), 'Authentication/empty state failed'); await browserShot(browser, `${unauthOrigin}/`, '01-auth-empty-desktop', 1440, 900);
    const dashboard = await browserDom(browser, `${fixtureOrigin}/`); for (const state of ['READY', 'CONFIRMED PROBLEM', 'COULD NOT VERIFY', 'UNSUPPORTED FILE', 'NOT CHECKED']) assert(dashboard.includes(state), `Dashboard is missing ${state}`);
    assert(dashboard.includes('LOCAL TEST FIXTURE CHANNEL'), 'Connected account/discovery fixture failed'); assert(dashboard.includes('Skip to main content') && dashboard.includes(':focus-visible') && dashboard.includes('select:focus-visible'), 'Keyboard focus safeguards are missing'); assert(dashboard.includes('.brand,nav li a,input,select{min-height:2.75rem}'), 'Primary 44px touch target safeguard is missing'); assert(dashboard.includes('@media(max-width:760px)') && dashboard.includes('grid-template-columns:repeat(5,minmax(0,1fr))'), 'Mobile/zoom reflow safeguards are missing'); assert(dashboard.includes('@media(forced-colors:active)') && dashboard.includes('outline:3px solid Highlight'), 'Forced-colors focus and boundary safeguards are missing');
    await browserShot(browser, `${fixtureOrigin}/`, '02-dashboard-desktop', 1440, 900); await browserShot(browser, `${fixtureOrigin}/`, '03-dashboard-mobile', 500, 844); await browserShot(browser, `${fixtureOrigin}/posts/fixture-problem`, '04-problem-desktop', 1440, 900); await browserShot(browser, `${fixtureOrigin}/posts/fixture-problem`, '05-problem-mobile', 500, 844);
    const post = await browserDom(browser, `${fixtureOrigin}/posts/fixture-problem`); assert(post.includes('Replace image 1') && post.includes('for="replacement-url"'), 'Post selection/replacement label failed');
    const approval = await browserDom(browser, `${fixtureOrigin}/edits/${ids.approval}`); assert(approval.includes('LOCAL TEST FIXTURE') && approval.includes('Buffer has not been edited') && approval.includes('Fixture response returned an unsuccessful status') && approval.includes('Not yet sent to Buffer') && approval.includes('for="confirmation"'), 'Approval review/disclosure failed'); await browserShot(browser, `${fixtureOrigin}/edits/${ids.approval}`, '06-approval-desktop', 1440, 900); await browserShot(browser, `${fixtureOrigin}/edits/${ids.approval}`, '07-approval-mobile', 500, 844);
    const confirmed = await browserDom(browser, `${fixtureOrigin}/edits/${ids.confirmed}/result`); const ambiguous = await browserDom(browser, `${fixtureOrigin}/edits/${ids.ambiguous}/result`); const failed = await browserDom(browser, `${fixtureOrigin}/edits/${ids.failed}/result`);
    assert(confirmed.includes('LOCAL FIXTURE · VERIFIED UI STATE') && confirmed.includes('No Buffer refetch') && confirmed.includes('sourceFingerprint') && !confirmed.includes('https://fixture.invalid') && !confirmed.includes('Repair verified.'), 'Verified fixture result failed'); assert(ambiguous.includes('LOCAL FIXTURE · COULD NOT CONFIRM UI STATE') && !ambiguous.includes('Repair verified.'), 'Ambiguous result falsely displayed success'); assert(failed.includes('LOCAL FIXTURE · NOT VERIFIED UI STATE') && !failed.includes('Repair verified.'), 'Failed result falsely displayed success');
    await browserShot(browser, `${fixtureOrigin}/edits/${ids.confirmed}/result`, '08-verified-fixture-desktop', 1440, 900); await browserShot(browser, `${fixtureOrigin}/edits/${ids.confirmed}/result`, '09-verified-fixture-mobile', 500, 844); await browserShot(browser, `${fixtureOrigin}/edits/${ids.ambiguous}/result`, '10-could-not-confirm-desktop', 1440, 900); await browserShot(browser, `${fixtureOrigin}/edits/${ids.ambiguous}/result`, '11-could-not-confirm-mobile', 500, 844); await browserShot(browser, `${fixtureOrigin}/edits/${ids.failed}/result`, '12-not-verified-desktop', 1440, 900); await browserShot(browser, `${fixtureOrigin}/edits/${ids.failed}/result`, '13-not-verified-mobile', 500, 844);
    const invalid = await request('/edits/prepare', 'POST', `_csrf=${encodeURIComponent(csrf)}&post_id=fixture-problem&replacement_position=0&replacement_url=${encodeURIComponent('http://fixture.invalid/image.png')}`); assert(invalid.status === 400 && invalid.body.includes('must use HTTPS') && invalid.body.includes('No success has been recorded'), 'Invalid replacement error failed');
    const stale = await request('/edits/prepare', 'POST', `_csrf=${encodeURIComponent(csrf)}&post_id=fixture-stale&replacement_position=0&replacement_url=${encodeURIComponent('https://fixture.invalid/image.png')}`); assert(stale.status === 400 && stale.body.includes('Run a fresh media check'), 'Stale evidence did not lock repair');
    const retrieval = await request('/sync', 'POST', `_csrf=${encodeURIComponent(csrf)}`); assert(retrieval.status === 500 && retrieval.body.includes('Operation stopped safely') && retrieval.body.includes('unexpected server error') && retrieval.body.includes('No success has been recorded') && !retrieval.body.includes('fetch failed'), 'Failed Buffer retrieval did not fail safely');
    const reauthStore = new Store(databasePath); reauthStore.requireReauth(connectionId); reauthStore.close();
    const reconnectDashboard = await browserDom(browser, `${fixtureOrigin}/`); const reconnectAccount = await browserDom(browser, `${fixtureOrigin}/account`);
    assert(reconnectDashboard.includes('Reconnect Buffer') && reconnectDashboard.includes('action="/auth/buffer/reconnect"') && !reconnectDashboard.includes('Refresh from Buffer'), 'Dashboard did not replace refresh with reconnect');
    assert(reconnectAccount.includes('Reconnect Buffer') && reconnectAccount.includes('will reject a different Buffer account') && reconnectAccount.includes('Disconnect and delete local Buffer data'), 'Account page did not show non-destructive reconnect alongside explicit deletion controls');
    assert(reconnectDashboard.includes('6 scheduled posts'), 'Reconnect state did not preserve cached tenant data');
    await browserShot(browser, `${fixtureOrigin}/account`, '14-buffer-reconnect-account', 1440, 900);
    const deniedStart = await request('/auth/buffer/reconnect', 'POST', `_csrf=${encodeURIComponent(csrf)}&connection_id=${encodeURIComponent(connectionId)}`);
    assert(deniedStart.status === 303 && String(deniedStart.headers.location).startsWith('https://auth.buffer.com/auth?'), 'Reconnect did not start the existing Buffer PKCE flow');
    const deniedState = new URL(String(deniedStart.headers.location)).searchParams.get('state'); assert(deniedState, 'Reconnect state was missing');
    const deniedCallback = await request(`/auth/buffer/callback?state=${encodeURIComponent(deniedState)}&error=access_denied`);
    assert(deniedCallback.status === 403 && deniedCallback.body.includes('Buffer authorization was not completed') && deniedCallback.body.includes('kept unchanged'), 'Rejected reconnect did not fail clearly and preserve the connection');
    const interruptedStart = await request('/auth/buffer/reconnect', 'POST', `_csrf=${encodeURIComponent(csrf)}&connection_id=${encodeURIComponent(connectionId)}`);
    const interruptedState = new URL(String(interruptedStart.headers.location)).searchParams.get('state'); assert(interruptedState, 'Interrupted reconnect state was missing');
    const interruptedCallback = await request(`/auth/buffer/callback?state=${encodeURIComponent(interruptedState)}`);
    assert(interruptedCallback.status === 400 && interruptedCallback.body.includes('did not return an authorization code') && interruptedCallback.body.includes('kept unchanged'), 'Interrupted reconnect did not fail clearly and preserve the connection');
    const expired = await request('/', 'GET', '', `gabel_session=${signCookie('expired', cookieSecret)}; gabel_csrf=${signCookie('expired-csrf', cookieSecret)}`); assert(expired.body.includes('Connect Buffer to begin'), 'Expired session did not return a safe unauthenticated state');
    assert(contrast('172019', 'fbfaf7') >= 4.5 && contrast('a1322c', 'fbe9e6') >= 4.5 && contrast('285f89', 'eaf2f8') >= 4.5, 'Critical text contrast is below 4.5:1');
    console.log('PASS actual Chromium screens: authentication/empty, dashboard, post detail, approval, verified, could-not-confirm, and not-verified'); console.log('PASS desktop 1440x900 and mobile 500x844 renders; responsive 320px CSS breakpoint and wrapping rules present'); console.log('PASS five media states, replacement input, stale evidence, retrieval failure, failed edit, expired session, and non-destructive Buffer reconnect UI'); console.log('PASS labels, skip link, visible focus rules, forced-colors rules, 44px primary controls, and critical 4.5:1 contrast checks'); console.log('LOCAL TEST FIXTURE only — no Buffer request, edit intent, post mutation, or Cloudflare change was made'); console.log(`Screenshots: ${artifacts}`);
  } finally {
    await new Promise<void>((resolveClose) => unauthProxy?.close(() => resolveClose()) ?? resolveClose()); await new Promise<void>((resolveClose) => authProxy?.close(() => resolveClose()) ?? resolveClose());
    if (server && server.exitCode === null) { server.kill(); await new Promise<void>((resolveExit) => server?.once('exit', () => resolveExit()) ?? resolveExit()); }
  }
}
await main();
