import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadConfig } from './config.ts';
import { Store } from './db.ts';
import { PostgresStore } from './postgres-db.ts';
import type { AppStore } from './persistence.ts';
import { BufferClient, BufferError, exchangeAuthorizationCode, safeBufferErrorDiagnostic } from './buffer.ts';
import { EditService } from './edit.ts';
import { beginOAuth, consumeOAuth } from './oauth.ts';
import { BufferAuthorizationError, bufferAuthorizationFailureEvidence, saveAuthorizedBufferConnection } from './buffer-authorization.ts';
import { randomToken, sanitize, sha256, signCookie, verifyCookie } from './security.ts';
import { expireCookie, serializeCookie, SESSION_COOKIE_MAX_AGE_SECONDS } from './cookies.ts';
import { renderPage } from './views.ts';
import { privacyNotice, termsOfService } from './legal.ts';
import { probeMediaUrl, publicMediaStatus } from './media-security.ts';
import type { AssetInput, BufferPost } from './types.ts';
import { ReplacementValidationError } from './replacement-validation.ts';
import { PublicError } from './errors.ts';

const config = loadConfig();
const gabelLogo = readFileSync(new URL('../public/gabel-logo.png', import.meta.url));
const isVercel = Boolean(process.env.VERCEL);
if (!isVercel && (!config.tlsKeyPath || !config.tlsCertPath)) throw new Error('TLS_KEY_PATH and TLS_CERT_PATH are required because Buffer requires HTTPS redirect URIs');
const store: AppStore = isVercel ? new PostgresStore(config.databaseUrl!) : new Store(config.databasePath);
let storeReady: Promise<void> | undefined;
function ensureStoreReady(): Promise<void> {
  if (!(store instanceof PostgresStore)) return Promise.resolve();
  storeReady ??= store.migrate().catch((error: unknown) => { storeReady = undefined; throw error; });
  return storeReady;
}
const retentionTimer = !isVercel ? setInterval(() => { void store.purgeExpiredData(); }, 60_000) : undefined;
retentionTimer?.unref();
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

async function session(req: IncomingMessage, res: ServerResponse): Promise<Context> {
  const jar = cookies(req);
  const rawId = verifyCookie(jar.gabel_session, config.cookieSecret);
  const rawCsrf = verifyCookie(jar.gabel_csrf, config.cookieSecret);
  if (rawId && rawCsrf) {
    const row = await store.getSession(sha256(rawId));
    if (row && row.csrf_hash === sha256(rawCsrf)) {
      await store.touchSession(sha256(rawId), new Date(Date.now() + SESSION_COOKIE_MAX_AGE_SECONDS * 1000).toISOString());
      // Refresh attributes so sessions created before the OAuth-compatible SameSite policy migrate safely.
      setSessionCookies(res, rawId, rawCsrf);
      return { tenantId: String(row.tenant_id), sessionHash: sha256(rawId), csrf: rawCsrf };
    }
  }
  const tenantId = randomUUID();
  const id = randomToken();
  const csrf = randomToken();
  await store.createTenant(tenantId);
  await store.createSession({ idHash: sha256(id), tenantId, csrfHash: sha256(csrf), expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString() });
  setSessionCookies(res, id, csrf);
  return { tenantId, sessionHash: sha256(id), csrf };
}

async function form(req: IncomingMessage, ctx: Context): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new PublicError('Request body is too large', 413, 'request_too_large');
    chunks.push(chunk);
  }
  const body = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  if (body.get('_csrf') !== ctx.csrf) throw new PublicError('Invalid CSRF token', 403, 'invalid_csrf');
  return body;
}

function page(title: string, body: string): string {
  return renderPage(title, body, config);
}

function html(res: ServerResponse, status: number, content: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer', 'permissions-policy': 'camera=(), microphone=(), geolocation=()', 'cross-origin-opener-policy': 'same-origin', ...(process.env.NODE_ENV === 'production' ? { 'strict-transport-security': 'max-age=31536000' } : {}), 'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self' https://auth.buffer.com; base-uri 'none'; frame-ancestors 'none'" });
  res.end(content);
}

function json(res: ServerResponse, status: number, content: Record<string, unknown>): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'cross-origin-opener-policy': 'same-origin', ...(process.env.NODE_ENV === 'production' ? { 'strict-transport-security': 'max-age=31536000' } : {}), 'content-security-policy': "default-src 'none'; frame-ancestors 'none'" });
  res.end(JSON.stringify(content));
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { location, 'cache-control': 'no-store', ...(process.env.NODE_ENV === 'production' ? { 'strict-transport-security': 'max-age=31536000' } : {}) });
  res.end();
}

function parseReplacements(value: string): Map<number, string> {
  const output = new Map<number, string>();
  for (const line of value.split(/\r?\n/).filter((item) => item.trim())) {
    const match = line.match(/^\s*(\d+)\s*=\s*(https:\/\/\S+)\s*$/);
    if (!match) throw new PublicError('A replacement entry is invalid. Use a media position and a direct HTTPS URL.');
    output.set(Number(match[1]), match[2]);
  }
  if (!output.size) throw new PublicError('At least one replacement is required');
  return output;
}

type MediaState = 'ready' | 'confirmed_problem' | 'could_not_verify' | 'unsupported_file';

const mediaStateContent: Record<MediaState | 'unchecked', { label: string; className: string; detail: string }> = {
  ready: { label: 'READY', className: 'status-ready', detail: 'The checked media responded with a supported image.' },
  confirmed_problem: { label: 'CONFIRMED PROBLEM', className: 'status-problem', detail: 'The media server returned a confirmed unsuccessful response.' },
  could_not_verify: { label: 'COULD NOT VERIFY', className: 'status-unknown', detail: 'A network or safety check prevented a reliable answer.' },
  unsupported_file: { label: 'UNSUPPORTED FILE', className: 'status-unsupported', detail: 'The media responded, but its file type is not supported here.' },
  unchecked: { label: 'NOT CHECKED', className: 'status-unchecked', detail: 'Run a fresh check before deciding whether this post needs attention.' },
};

function mediaPill(state: unknown): string {
  const key = typeof state === 'string' && state in mediaStateContent ? state as MediaState : 'unchecked';
  const item = mediaStateContent[key];
  return `<span class="status ${item.className}">${item.label}</span>`;
}

function aggregateMediaState(labels: string[]): MediaState {
  if (!labels.length) return 'could_not_verify';
  if (labels.includes('CONFIRMED PROBLEM')) return 'confirmed_problem';
  if (labels.includes('COULD NOT VERIFY')) return 'could_not_verify';
  if (labels.includes('UNSUPPORTED FILE')) return 'unsupported_file';
  return 'ready';
}

function formatDate(value: unknown): string {
  if (!value) return 'Time unavailable';
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return `${new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }).format(date)} UTC`;
}

function postReference(id: unknown): string { return sha256(String(id)).slice(0, 8).toUpperCase(); }

function renderPostCard(post: Record<string, unknown>): string {
  const state = typeof post.media_status === 'string' ? post.media_status : 'unchecked';
  const channel = post.channel_display_name ?? post.channel_name ?? 'Buffer channel';
  const checked = post.checked_at ? `Checked ${formatDate(post.checked_at)}` : 'A fresh media check has not run yet.';
  const action = state === 'confirmed_problem' ? 'Review confirmed problem' : state === 'unchecked' ? 'Check this post' : 'Review media status';
  return `<article class="post-card ${state === 'confirmed_problem' ? 'post-card-problem' : ''}"><div class="post-top"><h3>${esc(channel)}</h3>${mediaPill(state)}</div>
    <p>${esc(mediaStateContent[state in mediaStateContent ? state as MediaState : 'unchecked'].detail)}</p>
    <dl class="post-meta"><div><dt>Scheduled</dt><dd>${esc(formatDate(post.due_at))}</dd></div><div><dt>Media</dt><dd>${esc(post.asset_count)} ${Number(post.asset_count) === 1 ? 'asset' : 'assets'}</dd></div></dl>
    <small>${esc(checked)}</small><details class="evidence-details"><summary>Evidence details</summary><p>Post reference ${esc(postReference(post.id))}. ${esc(checked)}</p></details>
    <div class="post-actions"><a class="button ${state === 'confirmed_problem' ? '' : 'secondary'}" href="/posts/${encodeURIComponent(String(post.id))}">${action}</a></div></article>`;
}

function safeUrlLabel(value: string): string {
  return `URL fingerprint ${sha256(value).slice(0, 10)}`;
}

function validateReplacementUrlInput(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new PublicError('Enter a complete replacement image URL.'); }
  if (parsed.protocol !== 'https:') throw new PublicError('The replacement image must use HTTPS.');
  if (parsed.username || parsed.password) throw new PublicError('The replacement image URL cannot contain sign-in credentials.');
  return parsed.toString();
}

type StoredOutcome = {
  testFixture?: boolean;
  reason?: string;
  comparison?: { matches?: boolean; discrepancies?: string[] };
  replacementValidations?: Array<{ position: number; format: string; fileSizeBytes: number; dimensions: { width: number; height: number }; validatedAt: string }>;
  problemEvidence?: { checkedAt: string; summary: Array<{ position: number; label: string; detail?: string; httpStatus?: number }> };
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
};

function sanitizedPostEvidence(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!value) return { available: false };
  const assets = Array.isArray(value.assets) ? value.assets as Array<Record<string, unknown>> : [];
  return {
    available: true,
    postReference: postReference(value.id),
    status: value.status ?? 'missing',
    scheduledAt: value.dueAt ?? 'missing',
    shareMode: value.shareMode ?? 'missing',
    schedulingType: value.schedulingType ?? 'missing',
    channelReference: value.channelId ? postReference(value.channelId) : 'missing',
    textFingerprint: sha256(String(value.text ?? '')).slice(0, 12),
    metadataFingerprint: sha256(JSON.stringify(value.metadata ?? null)).slice(0, 12),
    tagsFingerprint: sha256(JSON.stringify(value.tags ?? [])).slice(0, 12),
    media: assets.map((asset, position) => ({
      position: position + 1,
      type: asset.type ?? 'unknown',
      format: asset.mimeType ?? 'unknown',
      sourceFingerprint: sha256(String(asset.source ?? '')).slice(0, 12),
    })),
  };
}

function fixtureNotice(outcome: StoredOutcome): string {
  return outcome.testFixture
    ? '<div class="notice info" role="status"><strong>LOCAL TEST FIXTURE</strong><p>This simulated record tests the interface only. It is not evidence of a live Buffer repair.</p></div>'
    : '';
}

function renderIntentPreview(intent: Record<string, string>): string {
  const before = JSON.parse(intent.before_json) as BufferPost;
  const intended = JSON.parse(intent.intended_assets_json) as AssetInput[];
  const outcome = JSON.parse(intent.outcome_json ?? '{}') as StoredOutcome;
  const problemSummary = outcome.problemEvidence?.summary ?? [];
  const changes = (outcome.replacementValidations ?? []).map((validation) => {
    const previous = before.assets[validation.position];
    const next = intended[validation.position];
    const nextUrl = next && 'image' in next ? next.image.url : '';
    const problem = problemSummary.find((item) => item.position === validation.position);
    return `<div class="change-comparison"><article class="change-side original"><p class="eyebrow">Before · image ${validation.position + 1}</p><div>${mediaPill('confirmed_problem')}</div><h3>Original image has a confirmed problem</h3><p>${esc(problem?.detail ?? 'A fresh media check confirmed an unsuccessful response.')}${problem?.httpStatus ? ` HTTP ${esc(problem.httpStatus)}.` : ''}</p><small>Checked ${esc(formatDate(outcome.problemEvidence?.checkedAt))}</small></article>
      <div class="change-arrow" aria-hidden="true">→</div><article class="change-side replacement"><p class="eyebrow">Proposed · image ${validation.position + 1}</p><span class="status status-ready">VALIDATED</span><h3>${esc(validation.format.toUpperCase())} replacement</h3><p>${esc(validation.dimensions.width)} × ${esc(validation.dimensions.height)} pixels<br>${esc(validation.fileSizeBytes.toLocaleString())} bytes</p><small>Validated ${esc(formatDate(validation.validatedAt))}. Not yet sent to Buffer.</small></article>
      <details class="evidence-details technical"><summary>Technical evidence and fingerprints</summary><dl class="technical-list"><div><dt>Original</dt><dd>${esc(safeUrlLabel(previous?.source ?? ''))}</dd></div><div><dt>Replacement</dt><dd>${esc(safeUrlLabel(nextUrl))}</dd></div><div><dt>Position</dt><dd>${validation.position + 1}</dd></div></dl><p>Full media URLs remain inside this short-lived intent and are never printed here.</p></details></div>`;
  }).join('');
  return `${fixtureNotice(outcome)}<div class="approval-head"><div><p class="eyebrow">Repair · approval</p><h1>Approve this media replacement.</h1><p class="lede">The replacement passed validation. Buffer has not been edited.</p></div><div class="approval-expiry"><strong>Approval expires</strong><span>${esc(formatDate(intent.expires_at))}</span></div></div>
    <div class="notice warn" role="status"><strong>No mutation has been sent.</strong> This approval expires ${esc(formatDate(intent.expires_at))}.</div>
    <section class="panel change-panel"><h2>Exact before-and-after change</h2>${changes}</section>
    <section class="panel"><h2>Everything else must remain unchanged</h2><div class="preserve-grid"><span>Post text</span><span>Scheduled time and mode</span><span>Destination channel</span><span>Post status and metadata</span><span>Tags</span><span>Untouched media and order</span></div></section>
    <div class="notice info"><strong>Fresh checks happen again.</strong> Gabel will refetch the post and replacement immediately before the edit, send only the complete asset list, then refetch and compare the result.</div>
    <form class="panel stack approval-form" method="post" action="/edits/${esc(intent.id)}/confirm"><input type="hidden" name="_csrf" value="${esc(intent.csrf)}"><h2>Approve the exact change above</h2><div class="field"><label for="confirmation">Type <code>EDIT POST ${esc(intent.post_id)}</code></label><input id="confirmation" name="confirmation" autocomplete="off" required><small>This one-time approval applies only to this reviewed media replacement.</small></div><button>Approve and repair this post</button></form>`;
}

function renderRepairResult(intent: Record<string, string>): { status: number; body: string } {
  const outcome = JSON.parse(intent.outcome_json ?? '{}') as StoredOutcome;
  const simulated = outcome.testFixture === true;
  const confirmedState = intent.status === 'confirmed' && outcome.comparison?.matches === true;
  const ambiguousState = intent.status === 'ambiguous';
  const verified = !simulated && confirmedState;
  const ambiguous = !simulated && ambiguousState;
  const label = simulated
    ? confirmedState ? 'LOCAL FIXTURE · VERIFIED UI STATE' : ambiguousState ? 'LOCAL FIXTURE · COULD NOT CONFIRM UI STATE' : 'LOCAL FIXTURE · NOT VERIFIED UI STATE'
    : verified ? 'VERIFIED' : ambiguous ? 'COULD NOT CONFIRM' : 'NOT VERIFIED';
  const heading = simulated
    ? confirmedState ? 'Fixture: verified outcome.' : ambiguousState ? 'Fixture: confirmation unavailable.' : 'Fixture: repair not verified.'
    : verified ? 'Repair verified.' : ambiguous ? 'Gabel could not confirm the repair.' : 'The repair was not verified.';
  const explanation = simulated
    ? 'This local fixture demonstrates the verification screen. It does not prove that Buffer was edited or refetched.'
    : verified
    ? 'A fresh Buffer response contained the intended image and every protected post field matched the fresh before-state.'
    : ambiguous
      ? 'The mutation outcome or fresh Buffer refetch was uncertain. Gabel has not recorded success.'
      : 'Gabel stopped without recording a successful repair.';
  const details = simulated
    ? 'No live Buffer success is claimed from this test record.'
    : verified
    ? 'Only the approved media list changed. Text, schedule, status, channel, metadata, tags, and untouched assets were preserved.'
    : outcome.comparison?.discrepancies?.join(' · ') || outcome.reason || 'Return to the post, retrieve fresh information, and decide what to do next.';
  const refetched = Boolean(outcome.after);
  const evidenceLabel = simulated ? 'No Buffer refetch — local fixture data only' : refetched ? 'Fresh Buffer refetch completed' : ambiguous ? 'Fresh Buffer refetch incomplete' : 'No verified after-state recorded';
  const technical = outcome.before || outcome.after ? `<details class="evidence-details technical"><summary>Technical comparison evidence</summary><p>Post content and media URLs are represented by non-reversible fingerprints.</p><div class="comparison-evidence"><div><h3>Fresh before evidence</h3><pre>${esc(JSON.stringify(sanitizedPostEvidence(outcome.before), null, 2))}</pre></div><div><h3>Fresh after evidence</h3><pre>${esc(JSON.stringify(sanitizedPostEvidence(outcome.after), null, 2))}</pre></div></div></details>` : '';
  return { status: simulated || verified ? 200 : 409, body: `${fixtureNotice(outcome)}<section class="result-head ${verified || (simulated && confirmedState) ? 'result-verified' : ambiguous || (simulated && ambiguousState) ? 'result-ambiguous' : 'result-failed'}"><p class="eyebrow">Verify</p><span class="result-label">${label}</span><h1>${heading}</h1><p class="lede">${explanation}</p></section>
    <div class="notice ${verified ? 'ok' : simulated ? 'info' : 'warn'}" role="status"><strong>${label}</strong><p>${esc(details)}</p></div>
    <section class="panel verification-proof"><h2>Verification evidence</h2><dl class="proof-list"><div><dt>Buffer refetch</dt><dd>${esc(evidenceLabel)}</dd></div><div><dt>Protected-field comparison</dt><dd>${simulated ? `Fixture state: ${outcome.comparison?.matches === true ? 'matched' : outcome.comparison ? 'not matched' : 'not completed'}` : outcome.comparison?.matches === true ? 'All compared fields matched' : outcome.comparison ? 'Differences or missing evidence found' : 'Not completed'}</dd></div><div><dt>Recorded outcome</dt><dd>${esc(simulated ? `Local fixture: ${intent.status}` : intent.status)}</dd></div></dl>${technical}</section>
    <a class="button" href="/workspace">Return to scheduled posts</a>` };
}

function renderLanding(): string {
  return `<section class="landing-hero" aria-labelledby="landing-title">
    <div class="landing-kicker reveal reveal-1">Buffer-native scheduled-media recovery</div>
    <h1 id="landing-title" class="reveal reveal-2">Keep scheduled posts <em>ready.</em></h1>
    <p class="landing-lede reveal reveal-3">Detect unavailable images before publication, approve one precise repair, and verify the fresh Buffer result.</p>
    <div class="landing-actions reveal reveal-4"><a class="button" href="/workspace">Open workspace</a><a class="button secondary" href="#how-it-works">See how it works</a></div>
  </section>
  <section id="product" class="product-stage reveal reveal-4" aria-label="Illustrative Gabel workflow preview">
    <div class="stage-bar"><span>Illustrative workflow</span><span>No account data shown</span></div>
    <div class="stage-grid">
      <div class="stage-sidebar"><strong>Scheduled media</strong><span class="stage-nav active">Review queue</span><span class="stage-nav">Evidence</span><span class="stage-nav">Account controls</span></div>
      <div class="stage-main"><div class="stage-title"><div><small>DETECT</small><h2>One clear path from evidence to outcome.</h2></div><span class="status status-problem">PROBLEM</span></div>
      <div class="stage-workflow" aria-label="Detect, review, approve, verify"><span class="done">01 <b>Detect</b></span><span>02 <b>Review</b></span><span>03 <b>Approve</b></span><span>04 <b>Verify</b></span></div>
      <div class="stage-card"><div><small>Protected change</small><strong>Replace only the affected image</strong><p>Text, timing, channel, metadata, tags, and media order remain guarded.</p></div><span class="stage-arrow" aria-hidden="true">&#8594;</span></div></div>
    </div>
  </section>
  <section id="how-it-works" class="landing-section"><div class="section-intro"><p class="eyebrow">How it works</p><h2>Evidence first. Mutation last.</h2><p>Gabel keeps every step explicit so a repair never quietly becomes a rewrite.</p></div>
    <ol class="process-grid"><li><span>01</span><h3>Detect</h3><p>Retrieve genuine scheduled posts and run a fresh, bounded media check.</p></li><li><span>02</span><h3>Review</h3><p>Show the affected position, the evidence timestamp, and the exact proposed replacement.</p></li><li><span>03</span><h3>Approve</h3><p>Require a one-time typed confirmation immediately before the Buffer edit.</p></li><li><span>04</span><h3>Verify</h3><p>Refetch the post and compare every protected field before recording success.</p></li></ol>
  </section>
  <section id="safeguards" class="landing-section safeguard-band"><div><p class="eyebrow">Safeguards</p><h2>A narrow repair surface by design.</h2></div><div class="safeguard-list"><p><strong>Fresh proof</strong><span>Stale or inconclusive checks never unlock repair.</span></p><p><strong>Explicit approval</strong><span>No mutation is sent from the review screen alone.</span></p><p><strong>Honest outcomes</strong><span>Ambiguous verification is never presented as success.</span></p></div></section>
  <section id="questions" class="landing-section questions"><div><p class="eyebrow">Questions</p><h2>Built for the moment between scheduling and publication.</h2></div><div><details><summary>Does Gabel edit post copy or timing?</summary><p>No. The repair is limited to approved image positions, with protected fields compared again after the edit.</p></details><details><summary>Does a READY check guarantee publication?</summary><p>No. It records a bounded result at a point in time; Buffer and social platforms still control publication.</p></details><details><summary>Is sample account data displayed?</summary><p>No. The workspace shows genuine authorized Buffer data or an honest empty state.</p></details></div></section>
  <section class="landing-cta"><p class="eyebrow">DETECT &#8594; REPAIR &#8594; VERIFY</p><h2>Give every scheduled image a fair second check.</h2><a class="button" href="/workspace">Open Gabel workspace</a></section>`;
}

async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', config.appOrigin);
  const rewrittenPath = url.searchParams.get('__gabel_path');
  if (isVercel && rewrittenPath !== null) {
    url.pathname = `/${rewrittenPath.replace(/^\/+/, '')}`;
    url.searchParams.delete('__gabel_path');
  }
  if (url.pathname === '/gabel-logo.png') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' }); res.end(); return;
    }
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': gabelLogo.length, 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : gabelLogo); return;
  }
  if (req.method === 'GET' && url.pathname === '/health/live') {
    json(res, 200, { status: 'ok' }); return;
  }
  await ensureStoreReady();
  if (req.method === 'GET' && url.pathname === '/health/ready') {
    try {
      const health = await store.healthCheck();
      json(res, health.ready ? 200 : 503, { status: health.ready ? 'ready' : 'not_ready', schemaVersion: health.schemaVersion });
    } catch {
      json(res, 503, { status: 'not_ready' });
    }
    return;
  }
  if (req.method === 'GET' && url.pathname === '/') {
    html(res, 200, page('Keep scheduled posts ready', renderLanding()));
    return;
  }
  const ctx = await session(req, res);
  if (req.method === 'GET' && url.pathname === '/workspace') {
    const connection = await store.getConnection(ctx.tenantId);
    const dashboard = await store.listDashboard(ctx.tenantId);
    const channels = dashboard.channels as Array<Record<string, unknown>>;
    const posts = dashboard.posts as Array<Record<string, unknown>>;
    const activeChannels = channels.filter((channel) => !channel.is_disconnected && !channel.is_locked);
    const orderedPosts = [...posts].sort((left, right) => Number(right.media_status === 'confirmed_problem') - Number(left.media_status === 'confirmed_problem') || String(left.due_at).localeCompare(String(right.due_at)));
    const confirmedProblems = posts.filter((post) => post.media_status === 'confirmed_problem').length;
    const intro = connection
      ? `<section class="dashboard-head"><div><p class="eyebrow">Scheduled media</p><h1>${confirmedProblems ? `${confirmedProblems} confirmed media ${confirmedProblems === 1 ? 'problem' : 'problems'}.` : 'Scheduled posts are ready to review.'}</h1><p class="lede">${confirmedProblems ? 'Review the affected posts first. Repair remains locked unless the evidence is fresh and conclusive.' : 'Check any post that has not been tested recently.'}</p></div><div class="flow" aria-label="Gabel workflow"><span>DETECT</span><b>→</b><span>REPAIR</span><b>→</b><span>VERIFY</span></div></section>`
      : `<section class="hero"><div><p class="eyebrow">Buffer-native media recovery</p><h1>Keep your scheduled posts ready.</h1><p class="lede">Check externally hosted images before publication, repair a confirmed problem with explicit approval, and verify that nothing else changed.</p></div><div class="flow" aria-label="Gabel workflow"><span>DETECT</span><b>→</b><span>REPAIR</span><b>→</b><span>VERIFY</span></div></section>`;
    html(res, 200, page('Scheduled posts', `${intro}
      <section class="panel connection"><div class="connection-copy"><span class="signal ${connection?.status === 'active' ? '' : 'off'}" aria-hidden="true"></span><div>${connection
        ? `<strong>Buffer account ${esc(sha256(connection.buffer_account_id).slice(0, 8).toUpperCase())}</strong><small>${connection.status === 'reauthorization_required' ? 'Authorization expired or was revoked. Reconnect without deleting your Gabel data.' : activeChannels.length ? `${activeChannels.map((channel) => esc(channel.display_name ?? channel.name)).join(', ')} · ${activeChannels.length} connected ${activeChannels.length === 1 ? 'channel' : 'channels'}` : 'Connected · retrieve channels to identify the destination'}</small>`
        : '<strong>No Buffer account connected</strong><small>Connect your account to retrieve genuine scheduled posts. Gabel shows no demo data.</small>'}</div></div>${connection
        ? connection.status === 'reauthorization_required'
          ? `<form method="post" action="/auth/buffer/reconnect"><input type="hidden" name="_csrf" value="${esc(ctx.csrf)}"><input type="hidden" name="connection_id" value="${esc(connection.id)}"><button>Reconnect Buffer</button></form>`
          : `<form method="post" action="/sync"><input type="hidden" name="_csrf" value="${esc(ctx.csrf)}"><button class="secondary">Refresh from Buffer</button></form>`
        : '<a class="button" href="/auth/buffer/start">Connect Buffer</a>'}</section>
      <div class="section-head queue-head"><div><p class="eyebrow">Scheduled queue</p><h2>${posts.length} scheduled ${posts.length === 1 ? 'post' : 'posts'}</h2></div><p class="hint">Confirmed problems appear first. Counts come from the retrieved Buffer queue.</p></div>
      ${posts.length ? `<div class="grid">${orderedPosts.map(renderPostCard).join('')}</div>` : `<div class="empty"><h2>${connection ? 'No scheduled posts retrieved' : 'Connect Buffer to begin'}</h2><p>${connection ? 'Refresh from Buffer. Draft, sent, and unavailable posts are not shown as scheduled work.' : 'Gabel will show only genuine posts from the account you authorize.'}</p></div>`}
      <div class="notice info"><strong>Honest checks, not publication promises.</strong> A READY result describes the bounded check at its timestamp. It cannot guarantee that a file will remain available or that Buffer or a social platform will publish it.</div>`));
    return;
  }
  const postMatch = url.pathname.match(/^\/posts\/([^/]+)$/);
  if (req.method === 'GET' && postMatch) {
    const connection = await store.getConnection(ctx.tenantId);
    if (!connection) { redirect(res, '/workspace'); return; }
    const postId = decodeURIComponent(postMatch[1]);
    const post = await store.getDashboardPost(ctx.tenantId, connection.id, postId);
    if (!post) { html(res, 404, page('Post not found', '<div class="empty"><h1>Post not found</h1><p>Refresh from Buffer to retrieve the current scheduled queue.</p><a class="button" href="/workspace">Return to posts</a></div>')); return; }
    const state = typeof post.media_status === 'string' && post.media_status in mediaStateContent ? post.media_status as MediaState : 'unchecked';
    const summary = post.summary_json ? JSON.parse(String(post.summary_json)) as Array<{ position: number; type: string; label: string; detail: string; httpStatus?: number }> : [];
    const problemPositions = await store.getFreshConfirmedProblemPositions(ctx.tenantId, connection.id, postId);
    const freshProblem = problemPositions.length > 0;
    const firstProblem = summary.find((item) => item.label === 'CONFIRMED PROBLEM');
    const affectedPosition = firstProblem?.position ?? problemPositions[0] ?? 0;
    const heading = freshProblem
      ? firstProblem?.httpStatus ? `Image ${affectedPosition + 1} returned HTTP ${firstProblem.httpStatus}.` : `Image ${affectedPosition + 1} is unavailable.`
      : state === 'confirmed_problem' ? `Recheck image ${affectedPosition + 1} before repair.`
      : state === 'ready' ? 'This post’s media is ready.'
      : state === 'could_not_verify' ? 'Gabel could not confirm this media.'
      : state === 'unsupported_file' ? 'This file is not supported for repair.' : 'Check this post’s media.';
    const evidenceRows = summary.map((item) => `<tr><td>Image ${esc(item.position + 1)}</td><td>${mediaPill(item.label === 'READY' ? 'ready' : item.label === 'CONFIRMED PROBLEM' ? 'confirmed_problem' : item.label === 'UNSUPPORTED FILE' ? 'unsupported_file' : 'could_not_verify')}</td><td>${esc(item.detail)}${item.httpStatus ? ` HTTP ${esc(item.httpStatus)}.` : ''}</td></tr>`).join('');
    const checkForm = `<form method="post" action="/media/check" class="post-actions"><input type="hidden" name="_csrf" value="${esc(ctx.csrf)}"><input type="hidden" name="post_id" value="${esc(postId)}"><button class="${freshProblem ? 'secondary' : ''}">${state === 'unchecked' ? 'Check media now' : 'Run a fresh check'}</button><small>The check may take several seconds.</small></form>`;
    const replacement = freshProblem ? `<section class="panel repair-panel"><p class="eyebrow">Next valid action</p><h2>Replace image ${problemPositions[0] + 1}</h2><p>Enter one stable public JPEG or PNG URL. Gabel will not accept it until the image passes network, format, size, and dimension validation.</p><form class="stack" method="post" action="/edits/prepare"><input type="hidden" name="_csrf" value="${esc(ctx.csrf)}"><input type="hidden" name="post_id" value="${esc(postId)}">${problemPositions.length > 1 ? `<div class="field"><label for="affected-position">Affected image</label><select id="affected-position" name="replacement_position">${problemPositions.map((position) => `<option value="${position}">Image ${position + 1}</option>`).join('')}</select></div>` : `<input type="hidden" name="replacement_position" value="${problemPositions[0]}"><p class="affected-media"><strong>Affected image</strong><span>Position ${problemPositions[0] + 1}</span></p>`}<div class="field"><label for="replacement-url">Replacement image URL</label><input id="replacement-url" name="replacement_url" type="url" inputmode="url" placeholder="https://media.example/image.jpg" aria-describedby="replacement-help" required><small id="replacement-help">HTTPS only. Use a direct, public URL without a login or short-lived signature.</small></div><button>Validate image and review change</button></form></section>` : `<section class="panel locked-panel"><p class="eyebrow">Repair locked</p><h2>${state === 'confirmed_problem' ? 'Fresh evidence is required.' : 'No confirmed repairable problem.'}</h2><p>${state === 'confirmed_problem' ? 'The earlier problem is more than ten minutes old. Run the check again before entering a replacement.' : 'Uncertain, unsupported, ready, and unchecked results never unlock repair.'}</p>${checkForm}</section>`;
    html(res, 200, page(heading, `<p><a href="/workspace">← All scheduled posts</a></p><section class="detail-head"><div><p class="eyebrow">Media status</p><h1>${esc(heading)}</h1><p class="lede">${esc(post.channel_display_name ?? post.channel_name ?? 'Buffer channel')} · scheduled ${esc(formatDate(post.due_at))}</p></div>${mediaPill(state)}</section>
      <div class="detail-grid"><section id="media" class="panel evidence-panel"><p class="eyebrow">Why Gabel reached this result</p><h2>${freshProblem ? `Image ${affectedPosition + 1} has a confirmed failure` : mediaStateContent[state].label}</h2><p>${esc(firstProblem?.detail ?? mediaStateContent[state].detail)}${firstProblem?.httpStatus ? ` The media server returned HTTP ${esc(firstProblem.httpStatus)}.` : ''}</p>${post.checked_at ? `<p class="evidence-time"><strong>Evidence recorded</strong><span>${esc(formatDate(post.checked_at))}</span></p>` : ''}${freshProblem ? checkForm : ''}<details class="evidence-details"><summary>Technical evidence</summary>${summary.length ? `<div class="table-wrap"><table><caption>Sanitized media evidence; URLs are not displayed</caption><thead><tr><th scope="col">Media</th><th scope="col">Result</th><th scope="col">Response</th></tr></thead><tbody>${evidenceRows}</tbody></table></div>` : '<p>No media evidence has been recorded.</p>'}<p>Post reference ${esc(postReference(postId))}. The bounded check reads at most 64 KiB and cannot guarantee future publication.</p></details></section>${replacement}</div>`));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/auth/buffer/start') {
    const existing = await store.getConnection(ctx.tenantId);
    if (existing) throw new PublicError(existing.status === 'reauthorization_required'
      ? 'This Buffer connection needs reauthorization. Use Reconnect Buffer so Gabel can verify the account before replacing credentials.'
      : 'This Gabel account already has an active Buffer connection.', 409, 'connection_already_exists');
    const auth = await beginOAuth(store, config, ctx.sessionHash);
    redirect(res, auth.url);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/auth/buffer/reconnect') {
    const body = await form(req, ctx);
    const connectionId = body.get('connection_id') ?? '';
    const connection = await store.getConnection(ctx.tenantId, connectionId);
    if (!connection) throw new PublicError('The Buffer connection was not found for this Gabel account.', 404, 'connection_not_found');
    if (connection.status !== 'reauthorization_required') { redirect(res, '/workspace'); return; }
    const auth = await beginOAuth(store, config, ctx.sessionHash, { connectionId: connection.id, expectedTokenVersion: connection.token_version });
    redirect(res, auth.url);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/auth/buffer/callback') {
    const returnedState = url.searchParams.get('state') ?? '';
    const oauth = await consumeOAuth(store, config, ctx.sessionHash, returnedState);
    if (!oauth) { html(res, 403, page('Reconnect stopped', '<div class="error"><h1>This Buffer authorization link is invalid or expired</h1><p>Return to Gabel and start Reconnect Buffer again. No credentials were changed.</p></div>')); return; }
    const operation = oauth.reconnect ? 'buffer_reauthorization' : 'oauth_authorization';
    if (url.searchParams.has('error')) {
      await store.addEvidence({ id: randomUUID(), tenantId: ctx.tenantId, operation, outcome: 'failure', sanitized: { reason: 'authorization_denied', error: url.searchParams.get('error') } });
      html(res, 403, page('Buffer authorization denied', `<div class="warn"><h1>Buffer authorization was not completed</h1><p>${oauth.reconnect ? 'Your existing Buffer connection, Gabel data, and evidence were kept unchanged.' : 'No Buffer connection was stored.'}</p><a class="button secondary" href="${oauth.reconnect ? '/account' : '/workspace'}">Return to Gabel</a></div>`)); return;
    }
    const code = url.searchParams.get('code');
    if (!code) {
      await store.addEvidence({ id: randomUUID(), tenantId: ctx.tenantId, operation, outcome: 'failure', sanitized: { reason: 'authorization_interrupted' } });
      html(res, 400, page('Buffer authorization interrupted', `<div class="error"><h1>Buffer did not return an authorization code</h1><p>${oauth.reconnect ? 'Your existing credentials and evidence were kept unchanged. Start Reconnect Buffer again when ready.' : 'No Buffer connection was stored.'}</p></div>`));
      return;
    }
    try {
      const tokens = await exchangeAuthorizationCode(config, code, oauth.verifier);
      const accountResult = await buffer.rawGraphql<{ account: { id: string } }>(tokens.access_token, 'query GabelAccountIdentity { account { id } }');
      const saved = await saveAuthorizedBufferConnection({ store, config, tenantId: ctx.tenantId, oauth, tokens, accountId: accountResult.data.account.id });
      await store.addEvidence({ id: randomUUID(), tenantId: ctx.tenantId, operation, outcome: 'success', requestId: accountResult.requestId,
        sanitized: { connectionId: saved.connectionId, accountIdHash: sha256(accountResult.data.account.id), scopes: tokens.scope.split(' '), reauthorized: saved.reauthorized } });
    } catch (error) {
      await store.addEvidence({ id: randomUUID(), tenantId: ctx.tenantId, operation, outcome: 'failure',
        requestId: error instanceof BufferError ? error.requestId : undefined,
        sanitized: bufferAuthorizationFailureEvidence(error) });
      if (error instanceof BufferAuthorizationError) {
        html(res, 409, page('Buffer reconnection stopped', `<div class="error"><h1>Buffer was not reconnected</h1><p>${esc(error.message)}</p><a class="button secondary" href="/account">Return to Account</a></div>`));
        return;
      }
      throw error;
    }
    redirect(res, '/workspace'); return;
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
    const connection = await store.getConnection(ctx.tenantId);
    html(res, 200, page('Account and data', `<h1>Account and data controls</h1>
      <section><h2>Buffer connection</h2>${connection ? `${connection.status === 'reauthorization_required' ? `<div class="notice warn"><strong>Buffer authorization needs attention</strong><p>Reconnect the same Buffer account to restore access. Gabel keeps your cached records and evidence, and will reject a different Buffer account.</p><form method="post" action="/auth/buffer/reconnect"><input type="hidden" name="_csrf" value="${esc(ctx.csrf)}"><input type="hidden" name="connection_id" value="${esc(connection.id)}"><button>Reconnect Buffer</button></form></div>` : '<div class="notice ok"><strong>Buffer is connected</strong><p>No reauthorization is currently required.</p></div>'}<p>Disconnecting deletes Gabel's encrypted Buffer credentials and cached Buffer records. Buffer does not document a programmatic OAuth revocation endpoint; to invalidate the grant at Buffer too, revoke Gabel in Buffer account settings.</p><form class="stack" method="post" action="/account/disconnect"><input type="hidden" name="_csrf" value="${esc(ctx.csrf)}"><label for="disconnect-confirmation">Type <code>DISCONNECT BUFFER</code></label><input id="disconnect-confirmation" name="confirmation" autocomplete="off" required><button>Disconnect and delete local Buffer data</button></form>` : '<p>No Buffer connection is stored for this browser account.</p>'}</section>
      <section class="card danger"><h2>Delete Gabel account data</h2><p>This permanently deletes this browser account, its sessions, cached Buffer records, encrypted credentials, edit intents, and evidence records from Gabel. This does not delete your Buffer account or social-platform content.</p><form class="stack" method="post" action="/account/delete"><input type="hidden" name="_csrf" value="${esc(ctx.csrf)}"><label for="delete-confirmation">Type <code>DELETE GABEL DATA</code></label><input id="delete-confirmation" name="confirmation" autocomplete="off" required><button>Delete Gabel data</button></form></section>`));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/account/disconnect') {
    const body = await form(req, ctx);
    if (body.get('confirmation') !== 'DISCONNECT BUFFER') throw new PublicError('Confirmation must exactly match DISCONNECT BUFFER');
    const connection = await store.getConnection(ctx.tenantId);
    if (!connection || !await store.disconnectConnection(ctx.tenantId, connection.id)) throw new PublicError('No Buffer connection was found');
    await store.addEvidence({ id: randomUUID(), tenantId: ctx.tenantId, operation: 'buffer_disconnect', outcome: 'success', sanitized: { localCredentialsDeleted: true, remoteRevocation: 'user_action_required_in_buffer' } });
    html(res, 200, page('Buffer disconnected', '<div class="card ok" role="status"><h1>Local Buffer connection deleted</h1><p>Gabel deleted its credentials and cached Buffer data. Revoke Gabel in Buffer settings if you also want Buffer to invalidate the grant.</p></div>'));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/account/delete') {
    const body = await form(req, ctx);
    if (body.get('confirmation') !== 'DELETE GABEL DATA') throw new PublicError('Confirmation must exactly match DELETE GABEL DATA');
    if (!await store.deleteTenant(ctx.tenantId)) throw new PublicError('Account data was not found');
    res.setHeader('set-cookie', [expireCookie('gabel_session', true), expireCookie('gabel_csrf', false)]);
    html(res, 200, page('Data deleted', '<div class="card ok" role="status"><h1>Gabel data deleted</h1><p>The local account and associated records were deleted. This did not delete the Buffer account or content held by Buffer or social platforms.</p></div>'));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/sync') {
    await form(req, ctx);
    const connection = await store.getConnection(ctx.tenantId);
    if (!connection) throw new PublicError('Authorize Buffer before discovery', 401, 'buffer_not_connected');
    await buffer.discover(ctx.tenantId, connection.id);
    redirect(res, '/workspace'); return;
  }
  if (req.method === 'POST' && url.pathname === '/media/check') {
    const body = await form(req, ctx);
    const connection = await store.getConnection(ctx.tenantId);
    const postId = body.get('post_id') ?? '';
    if (!connection) throw new PublicError('Authorize Buffer before checking media', 401, 'buffer_not_connected');
    if (!await store.hasCachedPost(ctx.tenantId, connection.id, postId)) throw new PublicError('Post was not retrieved for this Buffer connection');
    const { post, requestId } = await buffer.getPost(ctx.tenantId, connection.id, postId);
    const results = await Promise.all(post.assets.slice(0, 10).map(async (asset, position) => ({
      position, type: asset.type, result: await probeMediaUrl(asset.source),
    })));
    const summary = results.map((item) => {
      const status = publicMediaStatus(item.result);
      return { position: item.position, type: item.type, label: status.label, detail: status.detail, httpStatus: item.result.httpStatus };
    });
    const state = aggregateMediaState(summary.map((item) => item.label));
    const counts = Object.fromEntries(['reachable', 'unreachable', 'unsafe', 'error'].map((outcome) =>
      [outcome, results.filter((item) => item.result.outcome === outcome).length]));
    await store.saveMediaCheck({ tenantId: ctx.tenantId, connectionId: connection.id, postId, status: state,
      checkedCount: results.length, summary, requestId });
    await store.addEvidence({ id: randomUUID(), tenantId: ctx.tenantId, operation: 'media_availability_check', outcome: 'success', requestId,
      sanitized: { postIdHash: sha256(post.id), result: state, checkedCount: results.length, omittedCount: Math.max(0, post.assets.length - results.length), counts } });
    redirect(res, `/posts/${encodeURIComponent(postId)}#media`); return;
  }
  if (req.method === 'POST' && url.pathname === '/edits/prepare') {
    const body = await form(req, ctx);
    const connection = await store.getConnection(ctx.tenantId);
    if (!connection) throw new PublicError('Authorize Buffer before preparing an edit', 401, 'buffer_not_connected');
    const postId = body.get('post_id') ?? '';
    const problemPositions = await store.getFreshConfirmedProblemPositions(ctx.tenantId, connection.id, postId);
    const replacementPosition = Number(body.get('replacement_position') ?? '0');
    if (!problemPositions.includes(replacementPosition)) {
      throw new PublicError('Run a fresh media check and confirm a problem before preparing a repair');
    }
    const replacementUrl = body.get('replacement_url');
    const replacements = replacementUrl ? new Map([[replacementPosition, validateReplacementUrlInput(replacementUrl)]]) : parseReplacements(body.get('replacements') ?? '');
    const id = await edits.prepare(ctx.tenantId, connection.id, postId, replacements);
    redirect(res, `/edits/${id}`); return;
  }
  const editMatch = url.pathname.match(/^\/edits\/([0-9a-f-]+)$/);
  if (req.method === 'GET' && editMatch) {
    const intent = await store.getEditIntent(ctx.tenantId, editMatch[1]);
    if (!intent) { html(res, 404, page('Not found', '<h1>Edit intent not found</h1>')); return; }
    if (intent.status !== 'pending' || Date.parse(intent.expires_at) <= Date.now()) {
      html(res, 409, page('Repair unavailable', '<div class="notice warn"><h1>This approval is no longer active.</h1><p>Return to the scheduled post and run a fresh check before preparing another repair.</p></div><a class="button" href="/workspace">Return to posts</a>')); return;
    }
    html(res, 200, page('Review repair', renderIntentPreview({ ...intent, id: editMatch[1], csrf: ctx.csrf }))); return;
  }
  const resultMatch = url.pathname.match(/^\/edits\/([0-9a-f-]+)\/result$/);
  if (req.method === 'GET' && resultMatch) {
    const intent = await store.getEditIntent(ctx.tenantId, resultMatch[1]);
    if (!intent) { html(res, 404, page('Not found', '<h1>Repair result not found</h1><p>Expired repair records are deleted automatically.</p><a class="button" href="/workspace">Return to posts</a>')); return; }
    if (intent.status === 'pending') { redirect(res, `/edits/${resultMatch[1]}`); return; }
    const result = renderRepairResult(intent);
    html(res, result.status, page('Repair result', result.body)); return;
  }
  const confirmMatch = url.pathname.match(/^\/edits\/([0-9a-f-]+)\/confirm$/);
  if (req.method === 'POST' && confirmMatch) {
    const body = await form(req, ctx);
    await edits.confirm(ctx.tenantId, confirmMatch[1], body.get('confirmation') ?? '');
    redirect(res, `/edits/${confirmMatch[1]}/result`); return;
  }
  if (req.method === 'GET' && url.pathname === '/evidence') {
    const events = await store.listEvidence(ctx.tenantId);
    html(res, 200, page('Evidence', `<h1>Sanitized live evidence</h1>${events.length ? events.map((e) => `<div class="card"><strong>${esc(e.operation)}: ${esc(e.outcome)}</strong><br><small>${esc(e.created_at)} · request ID ${esc(e.request_id ?? 'not provided')}</small><pre>${esc(JSON.stringify(JSON.parse(String(e.sanitized_json)), null, 2))}</pre></div>`).join('') : '<p>No live operations have been completed. This is not evidence of a successful integration.</p>'}`)); return;
  }
  html(res, 404, page('Not found', '<h1>Not found</h1>'));
}

export default function requestHandler(req: IncomingMessage, res: ServerResponse): void {
  const requestId = randomUUID();
  res.setHeader('x-request-id', requestId);
  handler(req, res).catch((error: unknown) => {
    const status = error instanceof BufferError && error.kind === 'rate_limit' ? 429
      : error instanceof BufferError && error.kind === 'auth' ? 401
      : error instanceof PublicError ? error.status
      : error instanceof ReplacementValidationError ? 400 : 500;
    const diagnostic = error instanceof BufferError ? safeBufferErrorDiagnostic(error)
      : { type: error instanceof Error ? error.name : 'UnknownError', code: error instanceof PublicError ? error.code : undefined };
    console.error(JSON.stringify({ event: 'request_failed', requestId, method: req.method, path: new URL(req.url ?? '/', config.appOrigin).pathname, status, diagnostic }));
    const message = error instanceof BufferError
      ? `${error.message}${error.requestId ? ` (request ${error.requestId})` : ''}${error.retryAfter ? `; retry after ${error.retryAfter}s` : ''}`
      : error instanceof PublicError || error instanceof ReplacementValidationError ? error.message
      : `An unexpected server error occurred. Reference ${requestId}.`;
    html(res, status, page('Operation stopped', `<div class="error"><h1>Operation stopped safely</h1><p>${esc(message)}</p><p>No success has been recorded for this operation.</p></div><p><a href="/workspace">Return</a></p>`));
  });
}

const server = !isVercel
  ? createHttpsServer({ key: readFileSync(config.tlsKeyPath!), cert: readFileSync(config.tlsCertPath!) }, requestHandler)
  : undefined;

server?.on('clientError', (_error, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
});

server?.on('error', (error: NodeJS.ErrnoException) => {
  console.error(JSON.stringify({ event: 'server_error', code: error.code ?? 'unknown' }));
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  if (retentionTimer) clearInterval(retentionTimer);
  console.log(JSON.stringify({ event: 'shutdown_started', signal }));
  const forceTimer = setTimeout(() => {
    console.error(JSON.stringify({ event: 'shutdown_timeout' }));
    process.exit(1);
  }, 10_000);
  forceTimer.unref();
  server?.close(() => {
    clearTimeout(forceTimer);
    void store.close();
    console.log(JSON.stringify({ event: 'shutdown_complete' }));
  });
}

if (!isVercel) {
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

server?.listen(config.port, () => console.log(JSON.stringify({ event: 'server_started', origin: config.appOrigin, port: config.port })));
