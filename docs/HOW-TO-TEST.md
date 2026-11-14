# How to test Gabel

This is the complete judge and developer test guide. Gabel uses genuine authorized Buffer data and has no seeded demo account, fake posts, shared credentials, or reusable disposable post.

The public application is [https://gabel-six.vercel.app](https://gabel-six.vercel.app). One controlled disposable-post repair was verified live on November 8, 2026, then the post was deleted and the controlled media fixture was restored under separate approvals. That run is retained as evidence; it is not a currently reproducible judge sandbox.

## Start safely

You can inspect media without changing a Buffer post. Preparing a replacement also sends no mutation. A live edit happens only after a separate confirmation step in which the user types the exact post-specific phrase shown by Gabel.

Do not test repair on an important post. Start with the read-only media check and stop there unless every repair prerequisite is satisfied.

## Route A: judge / hosted application

### Prerequisites

- A Buffer account you are authorized to use.
- A connected Buffer channel.
- A scheduled post with externally hosted media.
- For repair only: a disposable scheduled **X image post** that is safe to edit.

There is no shared judge account, demo credential, or disposable scheduled post.

### Read-only test

1. Open [https://gabel-six.vercel.app](https://gabel-six.vercel.app).
2. Select **Open workspace**, then **Connect Buffer**.
3. Approve `account:read`, `posts:read`, `posts:write`, and `offline_access`. Gabel requests write access for the optional repair step; the media check itself does not edit the post.
4. Select **Refresh from Buffer**.
5. Find a scheduled post with media and select **Check media accessibility**. Gabel fetches the post again and checks up to ten assets without displaying their URLs.
6. Read the result:
   - **CONFIRMED PROBLEM** — the media server returned an unsuccessful HTTP response such as 404 or 410.
   - **COULD NOT VERIFY** — Gabel could not complete a safe network check. This does not prove that the file is unavailable.
   - **UNSUPPORTED FILE** — the server responded, but the reported and detected file types did not pass Gabel’s checks.
   - **READY** — the bounded checks passed now. This does not guarantee complete-file integrity, future availability, or publication.

Stop here for a safe read-only evaluation.

### Optional controlled repair

Continue only if you own the post, it is explicitly disposable, and you approve the exact change.

1. Use a stable, direct, unauthenticated public HTTPS JPEG or PNG. Do not use a signed, private, redirecting, or expiring URL.
2. Confirm the destination is a scheduled X image post. The current replacement gate accepts JPEG/PNG images up to 5 MB and 8192 × 8192 pixels.
3. Open a post with fresh **CONFIRMED PROBLEM** evidence, enter the replacement URL, and select **Validate image and review change**.
4. Review the original failure, replacement properties, affected image position, protected fields, and technical fingerprints. No Buffer mutation has occurred. The one-time review expires after ten minutes.
5. Only if every detail is correct, type the displayed `EDIT POST <post-id>` phrase and submit once. This is the step that sends the Buffer mutation.
6. Gabel fetches the post and replacement again immediately before the edit. A stale post, changed replacement, expired review, or failed validation stops the operation.
7. After Buffer responds, Gabel fetches the post again and compares the approved media with protected text, channel, schedule, status, metadata, tags, untouched media, and order.
8. Treat **Edit verified** as success only when that fresh comparison matches. Treat an uncertain mutation, failed after-read, or mismatch as ambiguous; inspect Buffer directly and do not retry automatically.

There is currently no authorized disposable setup for this repair path. Repeating the controlled proof requires a new disposable post, a bounded operator window, controlled media state, and each separate authorization documented in the [controlled repair plan](CONTROLLED-E2E-REPAIR-TEST-PLAN.md).

## Route B: developer / local application

### Prerequisites

- Node.js 24 or newer.
- A Buffer account and registered Buffer OAuth app client.
- The exact callback `https://localhost:3443/auth/buffer/callback` registered for local use, or matching values if the host or port changes. Buffer compares redirect URIs exactly.
- A local TLS certificate and private key in PEM format.
- For live read testing, a connected Buffer channel and a scheduled post with externally hosted media.
- For live repair testing, a separate disposable scheduled X image post and explicit approval of the exact change.

Never put real credentials in source files, command output, fixtures, logs, screenshots, or documentation.

### Install and configure

These commands use `npm.cmd`, which works in Windows PowerShell without depending on a PowerShell script-execution policy. In other shells, use the equivalent `npm` command.

```powershell
npm.cmd ci
Copy-Item -LiteralPath .env.example -Destination .env
```

Edit the Git-ignored `.env` file:

- `APP_ORIGIN` and `PORT` define the local HTTPS origin.
- `BUFFER_CLIENT_ID` is required. Set `BUFFER_CLIENT_SECRET` for a confidential Buffer client; the implementation also supports a registered public client that uses PKCE without a secret.
- `BUFFER_REDIRECT_URI` must match Buffer’s registered URI character for character.
- `APP_ENCRYPTION_KEY` and `APP_COOKIE_SECRET` must be different random 32-byte base64url values. Generate each separately with the command documented in `.env.example`.
- `TLS_KEY_PATH` and `TLS_CERT_PATH` must point to the PEM key and certificate. The repository does not install a certificate tool; use one approved for your environment.
- `OPERATOR_NAME`, `SUPPORT_EMAIL`, and `PRIVACY_EMAIL` must contain truthful values. Gabel refuses production startup when required values are blank or placeholders.
- `DATABASE_PATH` defaults to `./data/gabel.db`; the local SQLite database is created on first start.

Start the HTTPS application:

```powershell
npm.cmd start
```

Open `https://localhost:3443/`, or the exact `APP_ORIGIN` you configured. The product page is `/`; select **Open workspace** or visit `/workspace` for the Buffer workflow. The browser must trust the local certificate before the OAuth callback can complete normally.

For automatic development restart:

```powershell
npm.cmd run dev
```

### Run the available checks

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run integration
npm.cmd run integration:postgres
npm.cmd run browser
```

- `integration:postgres` requires a private `DATABASE_URL`; without it, the Neon test is skipped rather than claimed as passing.
- `browser` runs the real local server and Chromium against clearly labeled fixture states. Its screenshots are UI evidence, not live Buffer evidence.
- There is no lint script in `package.json`, so no lint command or result is claimed.

For an approved production deployment, follow [PRODUCTION-DEPLOYMENT.md](PRODUCTION-DEPLOYMENT.md). The `npm.cmd run production:check` preflight requires real production configuration, a public hostname, truthful contacts, and persistent storage; it is not expected to pass against the local example environment.

## Expected failure behavior

| Case | Expected behavior |
|---|---|
| Media returns 404/410 | **CONFIRMED PROBLEM**; no edit occurs. |
| DNS, TLS, timeout, or another inconclusive network failure | **COULD NOT VERIFY**; Gabel does not call the file broken. |
| Private, local, unsafe, credentialed, or non-HTTPS destination | The safety policy refuses the request or replacement. |
| MIME type and file signature disagree | **UNSUPPORTED FILE** or replacement rejection. |
| Replacement is unsupported, oversized, dimensionally invalid, or targets a non-X channel | No edit intent is created. |
| Post changes after review | Confirmation stops before mutation. |
| Replacement evidence expires or the bytes change | Confirmation stops before mutation. |
| Confirmation phrase is wrong or reused | No mutation is sent. |
| Mutation network outcome is uncertain | Gabel reports ambiguity and does not retry automatically. |
| Fresh after-read differs from intended or protected state | The result is not reported as verified success. |

## Cleanup

For read-only testing, no Buffer content cleanup is needed.

After evaluation:

1. Open **Account** in Gabel.
2. Type `DISCONNECT BUFFER` to delete Gabel’s encrypted Buffer credentials and connection-scoped cache.
3. Revoke Gabel in Buffer settings if you also want Buffer to invalidate the OAuth grant.
4. Type `DELETE GABEL DATA` only if you want to remove the browser tenant, sessions, edit intents, evidence, and remaining Gabel records. Neither action deletes Buffer posts.
5. If a separately authorized disposable post was created, clean it up manually in Buffer under separate approval. The browser application has no create/delete-post route.
6. Remove local `.env`, database, and certificate files according to your development policy. They are Git-ignored and must never be committed.

## Evidence and limitations

The repository contains sanitized live evidence for Buffer account, organization, channel, scheduled-post, asset, capability, schema/media-format, and media operations. It also records one explicitly approved assets-only `editPost` with a fresh zero-discrepancy preservation comparison from November 8, 2026. The controlled post was deleted afterward, so that proof is historical evidence rather than a judge sandbox.

The public deployment, production OAuth, and one authentic empty scheduled-queue sync were verified. A current end-to-end repair demonstration remains blocked on a new disposable scheduled post and separate mutation/cleanup approvals. Manual assistive-technology testing and qualified legal review remain incomplete; production compliance is still **FAILED**.

Read [JUDGE.md](../JUDGE.md) for the judge walkthrough, [BUFFER-LIVE-INTEGRATION-REPORT.md](BUFFER-LIVE-INTEGRATION-REPORT.md) for sanitized integration evidence, and [COMPLIANCE-PRIVACY-SECURITY-ACCESSIBILITY-GATE.md](COMPLIANCE-PRIVACY-SECURITY-ACCESSIBILITY-GATE.md) for the release boundary.
