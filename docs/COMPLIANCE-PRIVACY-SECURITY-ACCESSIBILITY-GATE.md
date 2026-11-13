# Compliance, privacy, security, and accessibility gate

Audit date: 2026-11-02 (Atlantic/Cape Verde)

## Gate result: FAIL — production/legal release is not approved

The repository now contains the applicable technical safeguards and evidence listed below, but this gate does not establish legal compliance or legal certification. Production release remains blocked on operator identity/contact configuration, qualified jurisdiction-specific legal review, manual accessibility testing, live Buffer integration testing, and an infrastructure review of key management, backups, logging, and production network egress. The next build phase must not begin automatically.

## Repository audit: what existed before this gate

Gabel was a Node.js 24 TypeScript HTTPS service with no runtime npm dependencies. It implemented Buffer Authorization Code + PKCE, encrypted access/refresh tokens and PKCE verifier storage, hashed session/OAuth state, signed Secure/SameSite cookies, CSRF checks, tenant-scoped database queries, Buffer GraphQL pagination, short-lived edit intents, exact typed confirmation, a fresh pre-mutation post fingerprint, an assets-only mutation, a fresh post-edit read, comparisons of schedule/text/channel/metadata/tags/assets, and explicit ambiguous-outcome reporting. The existing tests covered token secrecy, refresh rotation, cross-tenant connection isolation, field preservation, stale detection, rate limits, partial GraphQL responses, and mutation uncertainty.

The original code had no disconnect or deletion workflow, legal/contact pages, retention purge, dependency/license inventory, explicit SSRF destination policy, or accessibility test record. It also cached full scheduled-post text, full post JSON, media URLs, thumbnails, and asset metadata even though the dashboard did not use them. Forms and tables lacked some labels/captions, the page shell lacked a skip link and semantic landmarks, and focus styling was not explicit. No analytics, marketing tracker, email sender, payments, subscriptions, testimonials, metrics, images, icon set, or external fonts were found.

## Safeguards implemented by this gate

- Required `OPERATOR_NAME`, `SUPPORT_EMAIL`, and `PRIVACY_EMAIL` configuration; public contact details are shown in the shell and legal pages.
- Draft `/privacy` and `/terms` pages tied to actual behavior. They avoid certification claims and do not add refund/subscription terms.
- `/account` controls for explicit Buffer disconnect and full local-account deletion. Disconnect deletes encrypted credentials and connection-scoped cache. Account deletion relies on foreign-key cascades and expires both cookies.
- Honest revocation behavior: Buffer documents revocation through the user's Buffer settings, not a programmatic revocation endpoint. Gabel therefore deletes local credentials and tells the user to revoke the grant in Buffer separately.
- Sync-cache minimization: post text, complete post JSON, media URLs, thumbnails, and asset metadata are no longer retained. Legacy cached values are minimized at startup. Only scheduling metadata and media count remain.
- Automated expiry: cached organizations/channels/posts at 24 hours, complete edit intents at 10 minutes, expired sessions at seven days, and minimal evidence at 30 days.
- Public HTTPS media destination validation before an edit can be prepared. User-requested availability probes additionally pin a validated DNS address, re-resolve and revalidate every redirect, limit redirects/time/headers, inspect no more than a 64 KiB prefix for signature and dimensions, destroy the response as soon as inspection completes, and never display or persist the URL or prefix.
- Stronger browser response headers: no-store, CSP, nosniff, no-referrer, restrictive Permissions Policy, and frame blocking.
- Accessible shell and forms: semantic header/nav/main/footer, skip link, programmatic labels, table captions/scoped headings, visible focus, keyboard-native controls, status roles, wrapping preformatted output, and no positive tabindex.
- Truthful limitation text: destination/availability checks and Buffer responses cannot guarantee publication by Buffer or a social platform.

## Test execution

Executed on 2026-11-02:

- `npm.cmd run typecheck`: PASS.
- Original pre-gate `npm.cmd test` baseline: PASS — 26 passed, 0 failed, 0 skipped. The test names and assertions were inspected during the addendum reconciliation.
- Current `npm.cmd test`: PASS — 31 passed, 0 failed, 0 skipped or todo.
- Current `npm.cmd run integration`: PASS — 3 isolated temporary-file SQLite lifecycle tests passed.
- `npm.cmd audit --json`: PASS for the installed dependency graph; zero known advisories were returned by npm at execution time. This is a point-in-time registry result, not a guarantee.

## PASS / FAIL / NOT TESTED checklist

| Control | Status | Evidence / limitation |
|---|---|---|
| Privacy notice reflects actual processing | PASS | `/privacy`, `src/legal.ts`, data inventory |
| Terms reflect actual unpaid feasibility service | PASS | `/terms`; no refund/subscription policy |
| Operator/support contact | FAIL | Code requires configuration, but repository cannot supply the real operator values |
| Buffer-record minimization | PASS | No cached text/media URLs/full post JSON; minimization test |
| OAuth credential security | PASS | AES-256-GCM, PKCE, state, Secure cookies, exposure tests |
| Disconnect and revocation | PASS | Local deletion implemented; remote revocation truthfully requires Buffer user action |
| Account/personal-data deletion | PASS | UI/route/cascade test; off-browser identity-verification procedure needs operator process |
| Retention policy and purge | PASS | Implemented schedule and inventory |
| Dependency/service audit | PASS | Inventory plus executed npm advisory query |
| Cookie disclosure/consent review | PASS | Necessary cookies disclosed; jurisdiction-specific consent remains legal review |
| Analytics/marketing trackers | PASS | None found or added |
| Unsupported claims/testimonials/metrics | PASS | None found; success/ambiguity wording reviewed |
| SSRF/private destination protection | PASS | Automated address and redirect-policy tests |
| Cross-account access denial | PASS | Tenant-scoped lookups and automated denial test |
| Explicit edit authorization | PASS | Exact phrase plus CSRF; automated no-mutation test |
| Preserve unrelated post fields | PASS | Assets-only payload, reconstruction, automated comparison tests |
| Fresh Buffer verification | PASS | Fresh pre-write and post-write reads implemented; not live-tested |
| Partial/uncertain outcome reporting | PASS | Automated partial/ambiguous error tests |
| Form/keyboard/semantic accessibility | PASS | Automated structural checks; manual keyboard testing still NOT TESTED |
| WCAG 2.2 AA text contrast | PASS | Automated ratios for declared primary/small/button text pairs |
| Full WCAG 2.2 AA conformance | NOT TESTED | Requires manual and browser/assistive-technology review |
| Asset/code licenses | PASS | No external visual assets; dependency licenses inventoried |
| No paid-policy invention | PASS | No paid feature; terms explicitly say no current paid terms |
| No unnecessary marketing email | PASS | No email sender or campaign integration |
| Children's-data posture | PASS | No intentional collection feature; age/legal questions flagged |
| Live Buffer account access | PASS | Read-only identity and organization retrieval succeeded; interactive callback was not replayed |
| Live scheduled post/media/edit behavior | NOT TESTED | Authentic query returned zero posts/assets; requires a disposable scheduled media post and explicit edit approval |
| Production key management/backups/logging/egress | NOT TESTED | No deployment/infrastructure supplied |
| Qualified legal review | FAIL | Required before production; questions documented separately |

## Addendum reconciliation findings

The table below reconciles the November 2 findings with current source inspection and executed evidence. PASS means the stated technical requirement was demonstrated within the listed scope; it is not legal approval or a production certification.

| Requirement | Existing implementation | Test evidence | PASS / FAIL / NOT TESTED | Remaining action | Release-blocking status |
|---|---|---|---|---|---|
| Reconcile the reported 26 tests | The original suite covered OAuth/PKCE, encrypted storage, refresh concurrency, GraphQL behavior, edit preservation/authorization, tenant isolation, deletion/disconnect, minimization, SSRF basics, accessibility structure/contrast, and legal-copy assertions | Original execution record: 26/26. Re-execution before this addendum: 29/29. Current expanded execution: 31/31 | PASS | Maintain test-to-requirement traceability as behavior changes | No by itself |
| Credential encryption | AES-256-GCM with random 96-bit IV and authentication tag; 32-byte key required; ciphertext kept server-side | Round-trip, plaintext-absence, secret-redaction, and tamper-rejection assertions pass | PASS | Production secret storage, rotation, recovery, and access policy | Yes — infrastructure review |
| Refresh-token handling | Rotating token replaces encrypted access/refresh values; process-local promise lock; DB token-version compare-and-swap; auth failures require reauthorization | Three simultaneous callers produce one refresh; rotated token is persisted | PASS | Add distributed per-connection locking before multi-instance deployment | Yes if deployed with multiple processes |
| Cross-account authorization | Tenant-scoped connection, cached-post, edit-intent, disconnect, evidence, and dashboard access | Unit denial for connection/post/edit intent; isolated integration denial for cross-tenant disconnect | PASS | Continue route-level authorization review when new routes are added | No current defect |
| SSRF and redirects | HTTPS/443 only; URL credentials/local names prohibited; all DNS answers checked; validated address pinned; redirects re-resolved; bounded timeout/redirect/header behavior; body destroyed after headers | Private/link-local/metadata/reserved/multicast IPv4, IPv6 loopback/ULA/link-local/multicast/documentation/mapped IPv4, mixed DNS, encoded IPv4, redirects, same-host rebinding, limits, and URL-free errors pass | PASS | Enforce and validate production egress policy. The addendum initially exposed bracketed IPv6 normalization; it was corrected and the complete suite rerun | Yes — production egress validation |
| Account disconnection | Tenant-scoped connection deletion with foreign-key cascade for connection-owned cache/intents; tenant/session/evidence retained | Isolated temporary-file SQLite integration test passes and proves other tenant is unchanged | PASS | User must separately revoke the grant in Buffer settings | No for local deletion; remote revocation procedure required operationally |
| Account deletion | Tenant deletion cascades session, credentials, cache, intents, and evidence | Isolated temporary-file SQLite integration test passes and proves other tenant is unchanged | PASS | Define verified off-browser request handling and backup/log deletion | Yes — operational/privacy procedure |
| Retention cleanup | Expired sessions/intents, cache older than 24 hours, and evidence older than 30 days are purged; connection retained | Isolated temporary-file SQLite boundary test passes with fresh records preserved | PASS | Define backup/replica/log retention and orphan-tenant cleanup | Yes — production operations |
| Automated accessibility | Semantic page shell, skip link, native controls, labels, table semantics, focus indicator, tested palette ratios, no positive tabindex or current images | Render/source and contrast assertions pass in current 31-test suite | PASS | Keep automated checks in CI | No by itself |
| Manual accessibility | Not performed | No human keyboard, screen-reader, zoom/reflow, high-contrast, browser, or touch evaluation exists | NOT TESTED | Perform and document keyboard-only, screen-reader, 200%/400% zoom/reflow, high-contrast, error/focus-flow, and target-size testing | Yes |
| Privacy notice, terms, and inventory accuracy | Drafts describe actual cookies, Buffer/media processing, edit intents, cache minimization, retention, deletion, no trackers/marketing/payment, and publication limits | Source/data-flow review plus legal-copy assertions pass | PASS | Populate truthful contacts and obtain qualified jurisdiction-specific review | Yes |
| Qualified legal review | Outstanding questions are documented; no universal jurisdiction or certification claim is made | No counsel review evidence exists | FAIL | Resolve operator identity, applicable laws/roles/bases, request procedures, cookies, contracts, transfers, age, content/IP, accessibility, retention, incidents, and launch-market terms | Yes |
| Operator/support/privacy configuration | `loadConfig()` requires non-empty values and renders them into legal/contact UI | Safe configuration-presence check: all three are currently missing; no values were invented | FAIL | Set truthful `OPERATOR_NAME`, `SUPPORT_EMAIL`, and `PRIVACY_EMAIL` in deployment configuration | Yes |
| Project framework and playbook | All seven root project documents remain present. No Serial Hackathon Winner Playbook exists in the repository and none was fabricated | File inspection/search | FAIL for missing playbook; PASS for seven-document preservation | Supply the authoritative playbook if it is mandatory, then reconcile without rewriting history | Yes if competition rules require it |
| Production compliance gate | Gate remains failed | Release blockers above remain open | FAIL | Satisfy every mandatory release condition and rerun the gate | Yes |

## Release decision

This gate remains **FAILED** and is not cleared for production. Stop here. Do not advance to another build phase based on this report.

## 2026-11-07 production-readiness addendum

This addendum preserves the 2026-11-02 audit above while correcting facts that changed later:

- The complete 62-page Serial Hackathon Winner Playbook is available outside the repository and was re-read with unchanged SHA-256 `39bc70b51bec6617b5570827ae7138b8b80e4be65018776f2f2c15a293290377`. Its absence from Git is no longer treated as an unknown-requirements blocker.
- **LIVE READ-ONLY:** the current tenant-scoped verifier matched the stored Buffer account and retrieved one organization, one channel, one scheduled post, and one image asset; the bounded media probe returned HTTP 206 JPEG. No Buffer mutation or edit intent was sent.
- **VERIFIED AUTOMATED:** 68/68 unit/security tests, 4/4 isolated integration tests, type checking, and the approved local Chromium harness pass. A point-in-time approved-network npm audit returned zero known advisories.
- **IMPLEMENTED AND AUTOMATED:** strict production configuration/callback validation, TLS/database preflight, readiness/liveness, sanitized request-failure logging, graceful shutdown, sliding session inactivity, sessionless-tenant credential deletion, HSTS/frame/opener headers, forced-colors CSS, and bounded browser subprocesses.
- **BLOCKED / NOT TESTED:** Docker image execution because the local Docker daemon is unavailable; real production preflight because no approved public hostname/certificate/contacts/volume exist; manual assistive-technology review; qualified legal review; public deployment/judge access; and authentic live `editPost` preservation evidence.

The current blocker classification and exact deployment procedure are in `docs/PRODUCTION-DEPLOYMENT.md`. Production compliance remains **FAIL**; this addendum does not authorize deployment, submission, OAuth interaction, or a Buffer mutation.

## 2026-11-07 concurrency-hardening addendum

- **VERIFIED AUTOMATED:** edit confirmation now performs an atomic tenant-scoped SQLite claim before fresh validation or mutation-capable work. One intent can have only one durable claim; repeated, concurrent, cross-tenant, and expired confirmations fail closed. A claim is fenced again immediately before `editPost`. Once mutation starts, ambiguous transport or verification outcomes remain durable and cannot be automatically replayed.
- **VERIFIED AUTOMATED:** token refresh retains the in-process promise lock and adds a durable per-connection SQLite claim. Only the claim owner can mark a refresh request started or commit its response. Credential rotation and claim completion occur in one transaction with a token-version compare-and-swap. Stale refresh responses and stale reauthorization writes cannot overwrite or disable newer credentials.
- **VERIFIED AUTOMATED:** 73/73 unit/security tests and 5/5 isolated integration tests pass. The adversarial cases include two simultaneous approvals, repeated confirmation, an expired/crashed pre-mutation claim, ambiguous mutation response, cross-tenant and expired intents, independent SQLite refresh contenders, a possibly consumed refresh token, and stale credential writes.
- **IMPLEMENTED BUT NOT LIVE-TESTED:** no Buffer mutation or real rotating-token race was executed. Multi-process guarantees apply to processes sharing the same local SQLite database. Multi-host/shared-filesystem coordination remains outside the reviewed architecture and still requires a managed coordination/database design before horizontal scaling.

Production compliance remains **FAIL** for the pre-existing infrastructure, legal, manual-accessibility, public-judge, and live-repair blockers. This addendum authorizes no deployment or Buffer mutation.

## 2026-11-13 release-readiness addendum

- **VERIFIED LIVE on 2026-11-08:** one receipt-bound disposable X image post completed the full DETECT → REPAIR → VERIFY path. Gabel classified the controlled original as HTTP 410, validated the reviewed replacement, consumed one exact approval, sent one assets-only `editPost`, refetched the post, and recorded a zero-discrepancy comparison covering identity, channel, text, status, due time, scheduling modes, metadata, tags, asset count/order, replacement media, and alt text. The protected non-test post remained unchanged.
- **VERIFIED LIVE cleanup:** the disposable post was deleted under separate exact authorization; Buffer API absence, scheduled-discovery absence, zero marker matches, and operator dashboard absence were recorded. The controlled media Worker was restored under separate authorization and verified in its available state.
- **VERIFIED AUTOMATED on 2026-11-13:** the reusable lifecycle cleanup path now accepts either the signed original state or one uniquely completed and confirmed Gabel repair record. It still requires the exact receipt identity, tenant/connection scope, protected fields, scheduled state/time/modes/text/channel, one specifically authorized replacement image, current `deletePost` capability, and exact deletion confirmation. Unrelated or altered states fail closed.
- The live-repair evidence blocker recorded above is therefore resolved. Production compliance nevertheless remains **FAIL** because public judge access, approved production hosting and infrastructure controls, truthful production contacts, qualified legal review, and hands-on assistive-technology/accessibility testing remain incomplete. This addendum authorizes no deployment, OAuth interaction, or Buffer/Cloudflare mutation.

## 2026-11-13 Vercel production migration addendum

- **VERIFIED:** public Vercel access, durable Neon PostgreSQL persistence, production readiness, security headers, exact OAuth callback configuration, PKCE initiation, tenant cascade deletion, and durable cross-instance session/OAuth/edit-claim behavior.
- **IMPLEMENTED BUT UNVERIFIED:** live production Buffer callback completion and genuine post retrieval remain untested until the account owner completes OAuth.
- **BLOCKED:** qualified legal review and hands-on keyboard, screen-reader, forced-colors, zoom, orientation, and touch review remain outstanding. Production compliance therefore remains **FAIL**; deployment success is not a compliance certification.
