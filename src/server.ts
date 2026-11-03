import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadConfig } from './config.ts';
import { Store } from './db.ts';
import { BufferClient, BufferError, exchangeAuthorizationCode, safeBufferErrorDiagnostic } from './buffer.ts';
import { EditService } from './edit.ts';
import { beginOAuth, consumeOAuth } from './oauth.ts';
import { encrypt, randomToken, sanitize, sha256, signCookie, verifyCookie } from './security.ts';
import { expireCookie, serializeCookie } from './cookies.ts';
import { renderPage } from './views.ts';
import { privacyNotice, termsOfService } from './legal.ts';
import { probeMediaUrl, publicMediaStatus } from './media-security.ts';

const config = loadConfig();
if (!config.tlsKeyPath || !config.tlsCertPath) throw new Error('TLS_KEY_PATH and TLS_CERT_PATH are required because Buffer requires HTTPS redirect URIs');
const store = new Store(config.databasePath);
const retentionTimer = setInterval(() => store.purgeExpiredData(), 60_000);
retentionTimer.unref();
const buffer = new BufferClient(config, store);
const edits = new EditService(store, buffer);

type Context = { tenantId: string; sessionHash: string; csrf: string };
const esc = (v: unknown): string => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function cookies(req: IncomingMessage): Record<string, string> {
  return Object.fromEntries((req.headers.cookie ?? '').split(';').map((part) => part.trim().split(/=(.*)/s).slice(0, 2)).filter(([key]) => key));
}

function setCookie(res: ServerResponse, value: string, httpOnly: boolean): void {
  const existing = res.getHeader('set-cookie');
  const entry = serializeCookie(value, httpOnly);
  res.setHeader('set-cookie', [...(Array.isArray(existing) ? existing : existing ? [String(existing)] : []), entry]);
}

function setSessionCookies(res: ServerResponse, id: string, csrf: string): void {
  setCookie(res, `gabel_session=${signCookie(id, config.cookieSecret)}`, true);
  setCookie(res, `gabel_csrf=${signCookie(csrf, config.cookieSecret)}`, false);
}

function session(req: IncomingMessage, res: ServerResponse): Context {
  const jar = cookies(req);
  const rawId = verifyCookie(jar.gabel_session, config.cookieSecret);
  const rawCsrf = verifyCookie(jar.gabel_csrf, config.cookieSecret);
  if (rawId && rawCsrf) {
    const row = store.getSession(sha256(rawId));
    if (row && row.csrf_hash === sha256(rawCsrf)) {
      // Refresh attributes so sessions created before the OAuth-compatible SameSite policy migrate safely.
      setSessionCookies(res, rawId, rawCsrf);
      return { tenantId: String(row.tenant_id), sessionHash: sha256(rawId), csrf: rawCsrf };
    }
  }
  const tenantId = randomUUID();
  const id = randomToken();
  const csrf = randomToken();
  store.createTenant(tenantId);
  store.createSession({ idHash: sha256(id), tenantId, csrfHash: sha256(csrf), expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString() });
  setSessionCookies(res, id, csrf);
  return { tenantId, sessionHash: sha256(id), csrf };
}

async function form(req: IncomingMessage, ctx: Context): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  const body = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  if (body.get('_csrf') !== ctx.csrf) throw new Error('Invalid CSRF token');
  return body;
}

function page(title: string, body: string): string {
  return renderPage(title, body, config);
}

function html(res: ServerResponse, status: number, content: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'permissions-policy': 'camera=(), microphone=(), geolocation=()', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://auth.buffer.com; base-uri 'none'; frame-ancestors 'none'" });
  res.end(content);
}

function redirect(res: ServerResponse, location: string): void { res.writeHead(303, { location, 'cache-control': 'no-store' }); res.end(); }

function parseReplacements(value: string): Map<number, string> {
  const output = new Map<number, string>();
  for (const line of value.split(/\r?\n/).filter((item) => item.trim())) {
    const match = line.match(/^\s*(\d+)\s*=\s*(https:\/\/\S+)\s*$/);
    if (!match) throw new Error(`Invalid replacement line: ${line}`);
    output.set(Number(match[1]), match[2]);
  }
  if (!output.size) throw new Error('At least one replacement is required');
  return output;
}

async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ctx = session(req, res);
  const url = new URL(req.url ?? '/', config.appOrigin);
  if (req.method === 'GET' && url.pathname === '/') {
    const connection = store.getConnection(ctx.tenantId);
    const dashboard = store.listDashboard(ctx.tenantId);
    const channels = dashboard.channels as Array<Record<string, unknown>>;
    const posts = dashboard.posts as Array<Record<string, unknown>>;
    html(res, 200, page('Foundation', `<h1>Real Buffer integration</h1>
      <div class="card ${connection ? 'ok' : 'warn'}">${connection
        ? `Connection status: <strong>${esc(connection.status)}</strong>. Stored tokens are encrypted and never returned to this page.`
        : 'No Buffer account has been authorized. No demo data is shown.'}</div>
      <p>${connection ? `<form method="post" action="/sync"><input type="hidden" name="_csrf" value="${esc(ctx.csrf)}"><button>Retrieve genuine channels and scheduled posts</button></form>` : '<a class="button" href="/auth/buffer/start">Connect Buffer</a>'}</p>
      <h2>Channels (${channels.length})</h2>${channels.length ? `<table><caption>Connected Buffer channels</caption><thead><tr><th scope="col">ID</th><th scope="col">Name</th><th scope="col">Service</th><th scope="col">State</th></tr></thead><tbody>${channels.map((c) => `<tr><td><code>${esc(c.id)}</code></td><td>${esc(c.display_name ?? c.name)}</td><td>${esc(c.service)}</td><td>${c.is_disconnected ? 'Disconnected' : c.is_locked ? 'Locked' : 'Connected'}</td></tr>`).join('')}</tbody></table>` : '<p>No genuine channels have been retrieved.</p>'}
      <h2>Scheduled posts (${posts.length})</h2>${posts.length ? `<table><caption>Scheduled Buffer posts</caption><thead><tr><th scope="col">ID</th><th scope="col">Due</th><th scope="col">Media</th><th scope="col">Safe test</th></tr></thead><tbody>${posts.map((p, index) => `<tr><td><code>${esc(p.id)}</code></td><td>${esc(p.due_at ?? 'Unavailable')}</td><td>${esc(p.asset_count)}<form method="post" action="/media/check"><input type="hidden" name="_csrf" value="${esc(ctx.csrf)}"><input type="hidden" name="post_id" value="${esc(p.id)}"><button>Check media accessibility</button></form></td><td><form class="stack" method="post" action="/edits/prepare"><input type="hidden" name="_csrf" value="${esc(ctx.csrf)}"><input type="hidden" name="post_id" value="${esc(p.id)}"><label for="replacements-${index}">Replacement media URLs, one <code>position=https://…</code> per line</label><textarea id="replacements-${index}" name="replacements" rows="2" placeholder="0=https://public.example/replacement.jpg" required></textarea><button>Prepare only</button></form></td></tr>`).join('')}</tbody></table>` : '<p>No genuine scheduled posts have been retrieved.</p>'}
      <p><small>Gabel can validate intended changes and compare Buffer responses, but media availability checks cannot guarantee that Buffer or a third-party social platform will publish successfully.</small></p>`));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/auth/buffer/start') {
    const auth = beginOAuth(store, config, ctx.sessionHash);
    redirect(res, auth.url);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/auth/buffer/callback') {
    const returnedState = url.searchParams.get('state') ?? '';
    const verifier = consumeOAuth(store, config, ctx.sessionHash, returnedState);
    if (!verifier) { html(res, 403, page('OAuth rejected', '<div class="error"><h1>OAuth state validation failed</h1><p>No token exchange was attempted.</p></div>')); return; }
    if (url.searchParams.has('error')) {
      store.addEvidence({ id: randomUUID(), tenantId: ctx.tenantId, operation: 'oauth_authorization', outcome: 'failure', sanitized: { error: url.searchParams.get('error') } });
      html(res, 403, page('OAuth denied', '<div class="warn"><h1>Buffer authorization was denied</h1><p>No account was connected.</p></div>')); return;
    }
    const code = url.searchParams.get('code');
    if (!code) throw new Error('OAuth callback omitted the authorization code');
    const tokens = await exchangeAuthorizationCode(config, code, verifier);
    const granted = new Set(tokens.scope.split(/\s+/).filter(Boolean));
    const missing = ['account:read', 'posts:read', 'posts:write', 'offline_access'].filter((scope) => !granted.has(scope));
    if (missing.length || !tokens.refresh_token) {
      store.addEvidence({ id: randomUUID(), tenantId: ctx.tenantId, operation: 'oauth_authorization', outcome: 'failure',
        sanitized: { reason: 'insufficient_permissions', missingScopes: missing, refreshTokenReturned: Boolean(tokens.refresh_token) } });
      html(res, 403, page('Insufficient permissions', `<div class="error"><h1>Buffer did not grant the required access</h1><p>Missing: ${esc(missing.join(', ') || 'refresh token')}</p><p>No connection was stored.</p></div>`));
      return;
    }
    const accountResult = await buffer.rawGraphql<{ account: { id: string } }>(tokens.access_token, 'query GabelAccountIdentity { account { id } }');
    const connectionId = store.upsertConnection({ id: randomUUID(), tenant_id: ctx.tenantId, buffer_account_id: accountResult.data.account.id,
      access_token_ciphertext: encrypt(tokens.access_token, config.encryptionKey), refresh_token_ciphertext: tokens.refresh_token ? encrypt(tokens.refresh_token, config.encryptionKey) : null,
      access_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(), scopes: tokens.scope });
    store.addEvidence({ id: randomUUID(), tenantId: ctx.tenantId, operation: 'oauth_authorization', outcome: 'success', requestId: accountResult.requestId,
      sanitized: { connectionId, accountIdHash: sha256(accountResult.data.account.id), scopes: tokens.scope.split(' ') } });
    redirect(res, '/'); return;
  }
  if (req.method === 'GET' && url.pathname === '/privacy') {
    html(res, 200, page('Privacy notice', privacyNotice(config)));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/terms') {
    html(res, 200, page('Terms', termsOfService(config)));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/account') {
    const connection = store.getConnection(ctx.tenantId);
    html(res, 200, page('Account and data', `<h1>Account and data controls</h1>
      <section><h2>Buffer connection</h2>${connection ? `<p>Disconnecting deletes Gabel's encrypted Buffer credentials and cached Buffer records. Buffer does not document a programmatic OAuth revocation endpoint; to invalidate the grant at Buffer too, revoke Gabel in Buffer account settings.</p><form class="stack" method="post" action="/account/disconnect"><input type="hidden" name="_csrf" value="${esc(ctx.csrf)}"><label for="disconnect-confirmation">Type <code>DISCONNECT BUFFER</code></label><input id="disconnect-confirmation" name="confirmation" autocomplete="off" required><button>Disconnect and delete local Buffer data</button></form>` : '<p>No Buffer connection is stored for this browser account.</p>'}</section>
      <section class="card danger"><h2>Delete Gabel account data</h2><p>This permanently deletes this browser account, its sessions, cached Buffer records, encrypted credentials, edit intents, and evidence records from Gabel. This does not delete your Buffer account or social-platform content.</p><form class="stack" method="post" action="/account/delete"><input type="hidden" name="_csrf" value="${esc(ctx.csrf)}"><label for="delete-confirmation">Type <code>DELETE GABEL DATA</code></label><input id="delete-confirmation" name="confirmation" autocomplete="off" required><button>Delete Gabel data</button></form></section>`));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/account/disconnect') {
    const body = await form(req, ctx);
    if (body.get('confirmation') !== 'DISCONNECT BUFFER') throw new Error('Confirmation must exactly match DISCONNECT BUFFER');
    const connection = store.getConnection(ctx.tenantId);
    if (!connection || !store.disconnectConnection(ctx.tenantId, connection.id)) throw new Error('No Buffer connection was found');
    store.addEvidence({ id: randomUUID(), tenantId: ctx.tenantId, operation: 'buffer_disconnect', outcome: 'success', sanitized: { localCredentialsDeleted: true, remoteRevocation: 'user_action_required_in_buffer' } });
    html(res, 200, page('Buffer disconnected', '<div class="card ok" role="status"><h1>Local Buffer connection deleted</h1><p>Gabel deleted its credentials and cached Buffer data. Revoke Gabel in Buffer settings if you also want Buffer to invalidate the grant.</p></div>'));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/account/delete') {
    const body = await form(req, ctx);
    if (body.get('confirmation') !== 'DELETE GABEL DATA') throw new Error('Confirmation must exactly match DELETE GABEL DATA');
    if (!store.deleteTenant(ctx.tenantId)) throw new Error('Account data was not found');
    res.setHeader('set-cookie', [expireCookie('gabel_session', true), expireCookie('gabel_csrf', false)]);
    html(res, 200, page('Data deleted', '<div class="card ok" role="status"><h1>Gabel data deleted</h1><p>The local account and associated records were deleted. This did not delete the Buffer account or content held by Buffer or social platforms.</p></div>'));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/sync') {
    await form(req, ctx);
    const connection = store.getConnection(ctx.tenantId);
    if (!connection) throw new Error('Authorize Buffer before discovery');
    await buffer.discover(ctx.tenantId, connection.id);
    redirect(res, '/'); return;
  }
  if (req.method === 'POST' && url.pathname === '/media/check') {
    const body = await form(req, ctx);
    const connection = store.getConnection(ctx.tenantId);
    const postId = body.get('post_id') ?? '';
    if (!connection) throw new Error('Authorize Buffer before checking media');
    if (!store.hasCachedPost(ctx.tenantId, connection.id, postId)) throw new Error('Post was not retrieved for this Buffer connection');
    const { post, requestId } = await buffer.getPost(ctx.tenantId, connection.id, postId);
    const results = await Promise.all(post.assets.slice(0, 10).map(async (asset, position) => ({
      position, type: asset.type, result: await probeMediaUrl(asset.source),
    })));
    const counts = Object.fromEntries(['reachable', 'unreachable', 'unsafe', 'error'].map((outcome) =>
      [outcome, results.filter((item) => item.result.outcome === outcome).length]));
    store.addEvidence({ id: randomUUID(), tenantId: ctx.tenantId, operation: 'media_availability_check', outcome: 'success', requestId,
      sanitized: { postIdHash: sha256(post.id), checkedCount: results.length, omittedCount: Math.max(0, post.assets.length - results.length), counts } });
    html(res, 200, page('Media check', `<h1>Media accessibility check</h1>
      <p>This bounded check reads at most the first 64 KiB needed for the checks shown. It does not prove that the whole file is free from corruption or guarantee future publication by Buffer or a social platform.</p>
      ${results.length ? `<table><caption>Fresh results; URLs are intentionally not displayed</caption><thead><tr><th scope="col">Position</th><th scope="col">Type</th><th scope="col">Result</th><th scope="col">What it means</th></tr></thead><tbody>${results.map((item) => { const status = publicMediaStatus(item.result); return `<tr><td>${item.position}</td><td>${esc(item.type)}</td><td><strong>${esc(status.label)}</strong></td><td>${esc(status.detail)}</td></tr>`; }).join('')}</tbody></table>` : '<p>The post has no media assets to check.</p>'}
      ${post.assets.length > results.length ? `<p>${post.assets.length - results.length} additional assets were not tested because the per-request limit is 10.</p>` : ''}<p><a href="/">Return</a></p>`));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/edits/prepare') {
    const body = await form(req, ctx);
    const connection = store.getConnection(ctx.tenantId);
    if (!connection) throw new Error('Authorize Buffer before preparing an edit');
    const id = await edits.prepare(ctx.tenantId, connection.id, body.get('post_id') ?? '', parseReplacements(body.get('replacements') ?? ''));
    redirect(res, `/edits/${id}`); return;
  }
  const editMatch = url.pathname.match(/^\/edits\/([0-9a-f-]+)$/);
  if (req.method === 'GET' && editMatch) {
    const intent = store.db.prepare(`SELECT post_id,before_json,intended_assets_json,outcome_json,expires_at,status FROM edit_intents WHERE id=? AND tenant_id=?`).get(editMatch[1], ctx.tenantId) as Record<string, string> | undefined;
    if (!intent) { html(res, 404, page('Not found', '<h1>Edit intent not found</h1>')); return; }
    html(res, 200, page('Confirm edit', `<h1>Review intended Buffer change</h1><div class="card warn"><strong>No mutation has been sent.</strong> This one-time intent expires at ${esc(intent.expires_at)}.</div>
      <h2>Replacement check</h2><div class="card ok" role="status"><strong>READY</strong><p>The replacement passed the network, file-type, signature, size, dimension, and destination checks performed for this preview.</p><pre>${esc(JSON.stringify(JSON.parse(intent.outcome_json).replacementValidations, null, 2))}</pre><p>This bounded check cannot prove the whole file is free from corruption or guarantee future availability or publication.</p></div>
      <h2>Sanitized before-state</h2><pre>${esc(JSON.stringify(JSON.parse(intent.before_json), null, 2))}</pre><h2>Complete intended asset list</h2><pre>${esc(JSON.stringify(JSON.parse(intent.intended_assets_json), null, 2))}</pre>
      <p>Scheduling fields are deliberately omitted from the mutation. Gabel will refetch the post and revalidate the replacement immediately before editing, then refetch afterward.</p>
      <form method="post" action="/edits/${esc(editMatch[1])}/confirm"><input type="hidden" name="_csrf" value="${esc(ctx.csrf)}"><label>Type <code>EDIT POST ${esc(intent.post_id)}</code><br><input name="confirmation" size="70" required></label> <button>Send confirmed edit</button></form>`)); return;
  }
  const confirmMatch = url.pathname.match(/^\/edits\/([0-9a-f-]+)\/confirm$/);
  if (req.method === 'POST' && confirmMatch) {
    const body = await form(req, ctx);
    const comparison = await edits.confirm(ctx.tenantId, confirmMatch[1], body.get('confirmation') ?? '');
    html(res, comparison.matches ? 200 : 409, page('Edit result', `<h1>${comparison.matches ? 'Edit verified' : 'Edit outcome is ambiguous'}</h1><pre>${esc(JSON.stringify(comparison, null, 2))}</pre><p><a href="/">Return</a></p>`)); return;
  }
  if (req.method === 'GET' && url.pathname === '/evidence') {
    const events = store.db.prepare('SELECT operation,outcome,request_id,sanitized_json,created_at FROM evidence_events WHERE tenant_id=? ORDER BY created_at DESC').all(ctx.tenantId) as Array<Record<string, unknown>>;
    html(res, 200, page('Evidence', `<h1>Sanitized live evidence</h1>${events.length ? events.map((e) => `<div class="card"><strong>${esc(e.operation)}: ${esc(e.outcome)}</strong><br><small>${esc(e.created_at)} · request ID ${esc(e.request_id ?? 'not provided')}</small><pre>${esc(JSON.stringify(JSON.parse(String(e.sanitized_json)), null, 2))}</pre></div>`).join('') : '<p>No live operations have been completed. This is not evidence of a successful integration.</p>'}`)); return;
  }
  html(res, 404, page('Not found', '<h1>Not found</h1>'));
}

const server = createHttpsServer({ key: readFileSync(config.tlsKeyPath), cert: readFileSync(config.tlsCertPath) }, (req, res) => {
  handler(req, res).catch((error: unknown) => {
    if (error instanceof BufferError) console.error('Sanitized Buffer failure', JSON.stringify(safeBufferErrorDiagnostic(error)));
    const status = error instanceof BufferError && error.kind === 'rate_limit' ? 429 : error instanceof BufferError && error.kind === 'auth' ? 401 : 400;
    const message = error instanceof BufferError
      ? `${error.message}${error.requestId ? ` (request ${error.requestId})` : ''}${error.retryAfter ? `; retry after ${error.retryAfter}s` : ''}`
      : error instanceof Error ? error.message : 'Unexpected error';
    html(res, status, page('Operation stopped', `<div class="error"><h1>Operation stopped safely</h1><p>${esc(message)}</p><p>No success has been recorded for this operation.</p></div><p><a href="/">Return</a></p>`));
  });
});

server.listen(config.port, () => console.log(`Gabel listening on ${config.appOrigin}`));
