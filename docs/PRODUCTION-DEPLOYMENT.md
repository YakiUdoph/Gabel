# Production deployment procedure

Status: implemented deployment procedure; not deployed or production-certified. This procedure preserves Gabel's existing single-process Node.js HTTPS and SQLite architecture.

## Release-gate classification

| Finding | Classification | Current status / required evidence |
|---|---|---|
| Strict production environment, callback, port, timeout, contact, and distinct-secret validation | Must fix before deployment | Implemented and automated; run `npm run production:check` with the real deployment configuration. |
| TLS certificate/key validity and hostname coverage | Must fix before deployment | Automated preflight implemented; operator must supply the current certificate and private key through the deployment secret facility. |
| Persistent SQLite volume, schema migration, foreign keys, integrity/readiness, backup and restore | Must fix before deployment | Runtime and preflight checks implemented; operator must provision the persistent volume and perform a witnessed backup/restore drill. |
| Single application replica | Must fix before deployment | Still required for the reviewed SQLite deployment topology. Refresh and edit coordination now works across processes sharing the same SQLite database, but multi-host/shared-filesystem SQLite deployment is neither designed nor verified. |
| Production egress, DNS, firewall, key management, log collection, monitoring, and incident response | Must fix before deployment | Infrastructure/operator evidence is still missing. |
| Truthful operator name and public support/privacy mailboxes | Must fix before deployment | Code rejects blank, malformed, and obvious placeholder values. The operator must verify ownership and monitoring; the repository cannot do so. |
| Qualified review of the draft privacy notice and terms for the operator and launch markets | Must fix before submission | Not completed. The pages deliberately remain drafts and make no compliance certification. |
| Manual keyboard, screen-reader, forced-colors, and 200%/400% zoom review | Must fix before submission | Not completed. Automated structural/contrast/browser checks are not a conformance claim. |
| Public judge URL and a safe read-only judge walkthrough | Must fix before submission | No deployment exists. Configure only after deployment approval and a read-only smoke test. |
| Live controlled repair and fresh preservation proof | Must fix before a complete competition claim | Still absent and prohibited in this deployment-preparation task. Never substitute fixture evidence. |
| Durable refresh/edit coordination | Implemented for the current architecture | SQLite claims and fenced compare-and-swap coordinate processes using the same database. A managed coordination/database design remains mandatory before multi-host horizontal scaling. |
| Managed database migration away from SQLite | Optional improvement | Not required for the current single-process architecture; reassess with scale and availability requirements. |

## Verified application contract

Current official Buffer documentation requires Authorization Code with PKCE, a registered matching redirect URI, and bearer-authenticated GraphQL requests to `https://api.buffer.com`. Gabel uses the documented `https://auth.buffer.com/auth` and `/token` endpoints, verifies OAuth state, stores the PKCE verifier encrypted, and retrieves organizations, channels, and scheduled posts with GraphQL pagination. Sources: [Buffer authentication](https://developers.buffer.com/guides/authentication), [Buffer API introduction](https://developers.buffer.com/guides/introduction.html), and [scheduled-post retrieval](https://developers.buffer.com/examples/get-scheduled-posts.html).

This is implemented and has prior live read-only evidence. A new production OAuth callback and scheduled-post read remain untested until an approved deployment exists.

## Prerequisites

- One Linux host or container service with a persistent volume and exactly one Gabel replica.
- Public DNS for the final hostname.
- A currently valid public TLS certificate/private key whose certificate covers `APP_ORIGIN`.
- Inbound TCP 443 mapped to the container's TLS port 3443.
- Outbound DNS and HTTPS to Buffer plus public media hosts. Infrastructure egress controls must block private, loopback, link-local, metadata, and other prohibited destinations in addition to Gabel's application SSRF checks.
- A registered Buffer OAuth client whose redirect is exactly `APP_ORIGIN/auth/buffer/callback`.
- A secret manager or protected environment file readable only by the deployment operator.
- A persistent encrypted-at-rest volume for `/data` with documented backup, restore, retention, and deletion procedures.
- Verified operator identity and monitored support/privacy mailboxes. Do not use example values.

## Production environment

Set these outside the image and repository:

```text
NODE_ENV=production
APP_ORIGIN=https://your-approved-host.example
PORT=3443
BUFFER_CLIENT_ID=<registered client id>
BUFFER_CLIENT_SECRET=<only for a confidential client>
BUFFER_REDIRECT_URI=https://your-approved-host.example/auth/buffer/callback
APP_ENCRYPTION_KEY=<random 32-byte base64url value>
APP_COOKIE_SECRET=<different random 32-byte base64url value>
DATABASE_PATH=/data/gabel.db
TLS_KEY_PATH=/run/secrets/gabel-tls-key.pem
TLS_CERT_PATH=/run/secrets/gabel-tls-cert.pem
BUFFER_REQUEST_TIMEOUT_MS=15000
OPERATOR_NAME=<verified public operator name>
SUPPORT_EMAIL=<verified monitored mailbox>
PRIVACY_EMAIL=<verified monitored mailbox>
```

Store the environment as a protected deployment secret, not in Git. The encryption and cookie keys must be independently generated. Replacing the encryption key without a token re-encryption plan makes existing Buffer credentials unreadable. Replacing the cookie secret invalidates existing sessions.

## Build and preflight

From a clean checkout at the reviewed revision:

```sh
docker build --pull --tag gabel:reviewed .
docker volume create gabel-data
docker run --rm \
  --env-file /secure/path/gabel-production.env \
  --mount source=gabel-data,target=/data \
  --mount type=bind,source=/secure/path/tls-key.pem,target=/run/secrets/gabel-tls-key.pem,readonly \
  --mount type=bind,source=/secure/path/tls-cert.pem,target=/run/secrets/gabel-tls-cert.pem,readonly \
  gabel:reviewed node --experimental-strip-types scripts/check-production-readiness.ts
```

The preflight fails closed unless production configuration, callback equality, distinct keys, TLS validity/hostname, persistent SQLite migration, foreign keys, and database integrity pass. Its JSON output contains no credentials or filesystem paths.

## Backup before rollout

For the first deployment the volume may be empty. For every later rollout:

1. Stop the single Gabel container so SQLite has no active writer and closes its WAL cleanly.
2. Copy `/data/gabel.db` to encrypted backup storage.
3. Record the backup time, application revision, schema version, retention expiry, and authorized operator.
4. Restore the copy into an isolated volume and run the production preflight against that volume.
5. Do not continue if the restore/preflight fails.

Backups and infrastructure logs can contain personal data or encrypted credentials. Their deletion and retention must follow the operator-approved privacy procedure; application account deletion cannot erase infrastructure backups by itself.

## Start one replica

Only after explicit deployment approval:

```sh
docker run --detach \
  --name gabel \
  --restart unless-stopped \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --env-file /secure/path/gabel-production.env \
  --publish 443:3443 \
  --mount source=gabel-data,target=/data \
  --mount type=bind,source=/secure/path/tls-key.pem,target=/run/secrets/gabel-tls-key.pem,readonly \
  --mount type=bind,source=/secure/path/tls-cert.pem,target=/run/secrets/gabel-tls-cert.pem,readonly \
  gabel:reviewed
```

The image runs as the non-root `node` user. `/health/live` confirms the process can answer; `/health/ready` confirms foreign keys, schema version 3, and SQLite quick-check readiness. Health requests do not create browser tenants or cookies. Do not expose the container's 3443 port separately from the approved public 443 mapping.

## Read-only deployment verification

1. Confirm HTTPS certificate validity and security headers at the public origin.
2. Confirm `/health/live` and `/health/ready` return HTTP 200 and no `Set-Cookie` header.
3. Confirm the home, privacy, terms, and account pages show only the verified operator/contact values.
4. Complete genuine Buffer OAuth interactively using the exact registered callback. This requires the operator and must stop for operator interaction.
5. Use **Refresh from Buffer** and confirm genuine organizations/channels/scheduled posts are retrieved.
6. Optionally run a read-only media check on a post the operator controls.
7. Stop before replacement preparation or any edit intent. No mutation is needed for deployment verification.

## Logs and monitoring

Gabel writes one-line JSON lifecycle and request-failure events. Request failures include a generated request reference, method, path without query parameters, status, and a sanitized error category. They exclude cookies, request bodies, tokens, post text, media URLs, and raw unexpected exception messages. Configure collection with access control and a retention period approved by the operator.

Alert on readiness failure, restart loops, TLS expiry, persistent-volume capacity, repeated OAuth/Buffer authorization failures, and backup/restore failures. Never add request-body or header logging at the proxy.

## Rollback and shutdown

Gabel handles `SIGTERM`/`SIGINT`, stops accepting work, closes HTTPS, and closes SQLite. Allow at least ten seconds before force termination. Roll back only to a revision compatible with schema version 3 and run the preflight first. Restore a database backup only after stopping the sole writer and documenting the privacy/retention impact.

## Release decision boundary

This procedure and image are **implemented but not deployed**. Passing the automated preflight is necessary but does not prove infrastructure, legal, accessibility, judge access, or live repair compliance. Deployment and production-compliance status require separate operator evidence and approval.

## Verification record — 2026-11-07

Implementation blockers resolved in this pass:

- production configuration now rejects unknown `NODE_ENV` values and obvious placeholder Buffer client IDs;
- production HTML, JSON, health, and redirect responses emit HSTS; HTML/JSON also emit frame denial and same-origin opener isolation;
- browser sessions now use sliding seven-day inactivity expiry, and retention purges sessionless tenants so inaccessible encrypted Buffer credentials do not remain indefinitely;
- the privacy draft and data inventory now describe that actual inactivity/deletion behavior;
- forced-colors focus/boundary styles and bounded browser-test subprocesses were added.

Executed evidence:

- `npm.cmd run typecheck`: **PASS**.
- `npm.cmd test`: **PASS, 68/68**.
- `npm.cmd run integration`: **PASS, 4/4**.
- `npm.cmd run browser`: restricted GPU run **FAILED by a bounded Chrome timeout**; approved local headless-Chrome rerun **PASS**. This is fixture/UI evidence, not live Buffer repair evidence.
- `npm.cmd audit --json`: restricted network lookup **FAILED**; approved-network rerun **PASS with zero known advisories** at that point in time.
- tenant-scoped live Buffer read-only verifier: restricted runtime **FAILED with EACCES**; approved-network rerun **PASS** for account identity, one organization, one channel, one scheduled post, one image asset, and an SSRF-safe HTTP 206 JPEG check. `mutationSent` was false.
- production preflight against the local `.env`: **EXPECTED FAIL-CLOSED** because `APP_ORIGIN` is localhost, not a public production host. A real production preflight has not run because no approved hostname, certificate, contacts, or persistent production volume were supplied.
- Docker client 29.8.2 is installed, but the local Docker daemon is unavailable; image build/start verification is **BLOCKED / NOT EXECUTED** in this environment.

Remaining classification:

| Finding | Classification | Evidence needed |
|---|---|---|
| Approved public hostname, matching Buffer callback, valid public certificate, persistent encrypted volume, one replica, egress/firewall, secret manager, monitoring, and witnessed backup/restore | Must fix before deployment | Operator-provisioned infrastructure plus successful `production:check`, container startup, health, and backup/restore evidence |
| Verified operator identity and monitored support/privacy mailboxes | Must fix before deployment | Operator-supplied values and ownership/monitoring confirmation; none are invented in the repository |
| Qualified jurisdiction-specific review of draft privacy/terms and operational request/incident procedures | Must fix before submission | Review outcome from a qualified operator adviser/counsel |
| Human keyboard, screen-reader, forced-colors, 200%/400% zoom, orientation, and touch review | Must fix before submission | Recorded manual results and fixes for any verified defects |
| Public judge URL, fresh production OAuth callback, and genuine scheduled-post retrieval | Must fix before submission | Approved deployment followed by interactive OAuth and read-only smoke test |
| Authentic disposable-post `editPost` plus fresh protected-field preservation proof | Must fix before claiming the complete competition workflow | Separate controlled run and explicit mutation approvals; fixture results cannot substitute |
| Multi-host coordination or managed database | Optional for one-replica launch; mandatory before horizontal scaling | Current durable claims cover processes sharing one SQLite database; distributed storage/topology remains unverified and out of scope |

Production compliance remains **FAIL** because the operator/infrastructure, manual accessibility, legal, public judge-access, and live-repair evidence above do not yet exist.
