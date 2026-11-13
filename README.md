# Gabel

Gabel finds externally hosted media that may have become unavailable after a Buffer API post was scheduled. It lets the user check the media, review a replacement, and approve an asset-only edit without intentionally changing the post's text, channel, or scheduled time.

Gabel is a proof-stage Buffer Commit 2026 project. It uses genuine Buffer data and has no seeded demo account or fake posts. **Not deployed yet.** One controlled disposable-post repair was verified live on November 8, 2026, then the post was deleted and the controlled media fixture was restored. There is no public judge sandbox or reusable hosted test account.

## How to Test Gabel

You can inspect media without changing a Buffer post. Preparing a replacement also sends no mutation. A live edit happens only after a second step in which the user types an exact confirmation phrase.

### Route A: Judge / hosted application

**Current status: Not deployed yet.** There is no public URL, judge sandbox, demo account, or disposable test post. Until those exist, the hosted route cannot be reproduced safely.

When a hosted application is available, the route will require:

- a Buffer account that you are authorized to use;
- a connected Buffer channel;
- a scheduled post with externally hosted media; and
- for repair testing, a disposable scheduled **X image post** that is safe to edit.

Do not test repair on an important post. The read-only media check is the safe first test:

1. Open the hosted Gabel URL. It is **not available yet**.
2. Select **Connect Buffer** and approve `account:read`, `posts:read`, `posts:write`, and `offline_access`. Gabel needs write access for the optional repair step; checking media does not edit the post.
3. Select **Refresh from Buffer**.
4. Find a scheduled post with media and select **Check media accessibility**. Gabel fetches the post again and checks up to ten assets without displaying their URLs.
5. Read the result:
   - **CONFIRMED PROBLEM** — the media server returned an unsuccessful HTTP response such as 404.
   - **COULD NOT VERIFY** — Gabel could not complete a safe network check. This does not prove that the file is unavailable.
   - **UNSUPPORTED FILE** — the server responded, but the reported and detected file types did not pass Gabel's checks.
   - **READY** — the bounded checks passed now. This does not guarantee that the complete file is valid or that it will remain available until publication.

Stop here for a read-only evaluation. To test repair, use only a disposable scheduled X post that you control:

6. Supply a stable, direct, unauthenticated public HTTPS JPEG or PNG. The current repair gate accepts X image replacements only, up to 5 MB and 8192 by 8192 pixels. Do not use a signed, private, or expiring URL.
7. Open a post with a fresh **CONFIRMED PROBLEM**, enter the direct replacement URL, and select **Validate image and review change**. This validates the destination, response, MIME type, file signature, size, dimensions, and current Buffer media-format support. It does not edit Buffer.
8. Review the confirmed original failure, validated replacement properties, protected fields, and technical fingerprints. The one-time review expires after ten minutes.
9. Only if the change is correct and the post is disposable, type the displayed `EDIT POST <post-id>` phrase and submit it. This step sends the Buffer mutation.
10. Gabel fetches the post and replacement again immediately before the edit. After Buffer responds, Gabel fetches the post once more and compares the media, text, channel, and scheduling fields. It reports an uncertain or mismatched result as ambiguous rather than as success.
11. Open **Account** to disconnect. Type `DISCONNECT BUFFER` to delete Gabel's encrypted Buffer credentials and cached connection data. Revoke Gabel in Buffer settings as well if you want Buffer to invalidate the grant. `DELETE GABEL DATA` removes the browser account and its local Gabel records; neither action deletes Buffer posts.

The repository has live evidence for Buffer account, organization, channel, scheduled-post, asset, schema, read-only media operations, and one explicitly approved assets-only `editPost` followed by a fresh zero-discrepancy preservation comparison. That controlled post was deleted afterward, so the result is evidence—not a currently reproducible judge sandbox. See [JUDGE.md](JUDGE.md) for the evaluation guide and remaining blockers.

### Route B: Developer / local testing

#### Prerequisites

- Node.js 24 or newer.
- A Buffer account and a registered Buffer OAuth app client.
- The exact callback `https://localhost:3443/auth/buffer/callback` registered for local use, or matching values if you change the host or port. Buffer requires HTTPS even on localhost and compares redirect URIs exactly.
- A local TLS certificate and private key in PEM format.
- For live read testing, a connected Buffer channel and a scheduled post with externally hosted media.
- For live repair testing, a separate disposable scheduled X image post and explicit approval of the exact change.

Never put real credentials in source files, command output, fixtures, or documentation.

#### Install and configure

The commands below use `npm.cmd`, which works in Windows PowerShell without depending on a PowerShell script-execution policy. In other shells, the equivalent command is `npm`.

```powershell
npm.cmd ci
Copy-Item -LiteralPath .env.example -Destination .env
```

Edit the Git-ignored `.env` file. Keep the names and paths from `.env.example`:

- `APP_ORIGIN` and `PORT` define the local HTTPS origin.
- `BUFFER_CLIENT_ID` is required. Set `BUFFER_CLIENT_SECRET` for a confidential Buffer client; the implementation also supports a registered public client that uses PKCE without a secret.
- `BUFFER_REDIRECT_URI` must match the URI registered with Buffer character for character.
- `APP_ENCRYPTION_KEY` and `APP_COOKIE_SECRET` must be different random 32-byte base64url values. Generate each value separately with the command already documented in `.env.example`.
- `TLS_KEY_PATH` and `TLS_CERT_PATH` must point to the PEM key and certificate. The repository does not install a certificate tool; create a locally trusted certificate with a tool approved for your environment.
- `OPERATOR_NAME`, `SUPPORT_EMAIL`, and `PRIVACY_EMAIL` must contain truthful local/deployment values. Gabel refuses to start when they are blank.
- `DATABASE_PATH` defaults to `./data/gabel.db`. The database is created on first start.

Start the HTTPS application:

```powershell
npm.cmd start
```

Open `https://localhost:3443/`, or the exact `APP_ORIGIN` you configured. Your browser must trust the local certificate before the Buffer callback can complete normally.

For development with automatic restart:

```powershell
npm.cmd run dev
```

Run the available checks:

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run integration
npm.cmd run browser
```

There is no lint script in `package.json`, so no lint command or result is claimed.

For an approved production deployment, follow [docs/PRODUCTION-DEPLOYMENT.md](docs/PRODUCTION-DEPLOYMENT.md). The `npm.cmd run production:check` preflight requires the real `NODE_ENV=production` configuration, public hostname, matching TLS certificate, truthful contacts, and persistent database; it is not expected to pass with the local example environment.

## Evidence status

| Classification | Current evidence |
|---|---|
| Implemented | Buffer OAuth with PKCE, encrypted server-side tokens, scheduled-post retrieval, bounded media checks, X JPEG/PNG replacement validation, explicit single-use approval, stale-state checks, assets-only editing, fresh after-read comparison, disconnect, deletion, and retention controls. |
| Verified with the live Buffer API | Account, organization, channel, scheduled post, image asset, update capability, schema/media-format reads, and sanitized read-only media evidence. |
| Verified by automated tests | OAuth and token handling, tenant isolation, media safety, replacement rules, asset ordering and preservation, exact approval, stale-state rejection, ambiguity handling, deletion, retention, and structural accessibility checks. Mocked Buffer tests are not live evidence. |
| Verified with a controlled live mutation | One receipt-bound disposable X image post completed DETECT → REPAIR → VERIFY on November 8, 2026: HTTP 410 detection, validated replacement, exact approval, one assets-only `editPost`, and a fresh zero-discrepancy preservation comparison. Cleanup and fixture restoration were separately authorized and verified. |
| Blocked | Public judge reproduction and production release. There is no deployment, current disposable-post setup, or judge account, and the compliance gate remains failed. |
| Planned, not implemented | Background monitoring, automatic repair, bulk editing, and support for replacement workflows beyond the current X JPEG/PNG image path. |

## How Gabel protects a repair

Gabel keeps Buffer credentials on the server and encrypts them at rest. Every user-owned record is scoped to a random browser tenant. Media checks allow only public HTTPS destinations, validate resolved addresses, pin a validated address for the connection, and recheck redirects. They inspect no more than a 64 KiB prefix for format and dimensions and never show the source URL in results.

Preparing an edit builds the complete ordered asset list and records the current post state. Confirmation is single-use and requires the exact post-specific phrase. Immediately before editing, Gabel fetches the post again and revalidates the replacement; any stale post, stale validation, or changed replacement stops the operation. It sends only `id` and `assets`, then fetches the post again to compare protected fields. It never automatically retries an uncertain mutation.

## Repository map

- `src/server.ts` — HTTPS routes, the server-rendered interface, OAuth callback, media check, edit review, account controls, and evidence page.
- `src/buffer.ts` — Buffer OAuth token exchange/rotation and GraphQL transport.
- `src/media-security.ts` — bounded HTTPS media probing and SSRF protections.
- `src/replacement-validation.ts` — current X JPEG/PNG replacement requirements and fresh-evidence checks.
- `src/edit.ts` — complete asset construction, approval, mutation, and verification.
- `src/controlled-test-post.ts` and `scripts/controlled-buffer-post.ts` — local, receipt-bound disposable-post creation/inspection/cleanup tooling; it is not an application endpoint. It was used in controlled live runs and now accepts cleanup only for the signed original state or one uniquely completed, verified Gabel repair state.
- `src/db.ts` — tenant-scoped SQLite persistence, deletion, and retention.
- `test/` — automated tests; mocked responses are never presented as live Buffer evidence.
- `docs/BUFFER-LIVE-INTEGRATION-REPORT.md` — sanitized live/read evidence.
- `docs/CONTROLLED-E2E-REPAIR-TEST-PLAN.md` — the unexecuted controlled repair plan and authorization points.
- `docs/CONTROLLED-BUFFER-POST-LIFECYCLE.md` — the separately authorized operator lifecycle and cleanup recovery procedure.
- `tooling/cloudflare-workers-media/` — an undeployed Workers Free bundled-static-assets fixture with project-generated test images and separately deployable available/revoked states.
- `docs/COMPETITIVE-VALIDATION-AND-SERIAL-WINNER-SCORE.md` — current product validation and judgeability assessment.
- `docs/PRODUCTION-DEPLOYMENT.md` — single-replica build, fail-closed preflight, persistent SQLite, health, backup, logging, rollback, and read-only verification procedure.

## Release status

The current compliance report is [docs/COMPLIANCE-PRIVACY-SECURITY-ACCESSIBILITY-GATE.md](docs/COMPLIANCE-PRIVACY-SECURITY-ACCESSIBILITY-GATE.md), with the latest production execution record in [docs/PRODUCTION-DEPLOYMENT.md](docs/PRODUCTION-DEPLOYMENT.md). Production compliance remains **FAILED**. Application-level production validation, health checks, safe logging, graceful shutdown, schema readiness, inactivity deletion, automated browser/accessibility checks, and a repeatable container procedure are implemented, but public release is still blocked by verified production contacts, qualified legal review, manual assistive-technology testing, an approved public deployment, judge reproduction, and operator infrastructure evidence. Do not treat this repository as a production certification or competition-ready deployment.
