# Gabel — Buffer integration foundation

Gabel Phase 1 is a proof-first TypeScript service for connecting a real Buffer account, retrieving genuine channels and scheduled posts, inspecting documented media fields, and running a single explicitly confirmed `editPost` feasibility test. It contains no seeded or demo Buffer data and does not implement monitoring or automatic repair.

## Architecture and repository structure

- `src/server.ts` — HTTPS server, server-rendered review UI, signed sessions, CSRF checks, OAuth and guarded edit routes.
- `src/buffer.ts` — Buffer OAuth token exchange/rotation, GraphQL transport, error classification and paginated discovery.
- `src/edit.ts` — complete asset-list construction, stale-post guard, mutation confirmation and post-edit verification.
- `src/db.ts` — tenant-scoped SQLite persistence.
- `src/security.ts` — AES-256-GCM credential encryption, PKCE and sanitization.
- `migrations/001_initial.sql` — initial schema.
- `test/` — isolated tests; mocked responses are not live-integration evidence.
- `docs/PHASE-1-FEASIBILITY.md` — capability and evidence report.

Runtime requirements: Node.js 24+, SQLite support bundled with Node, an HTTPS certificate, a registered confidential Buffer app client, and a real Buffer account containing a user-controlled scheduled test post. The service has no runtime npm dependencies.

## Setup

1. Register a private app client in Buffer Settings → API. Enable only `account:read`, `posts:read`, `posts:write`, and `offline_access`.
2. Register the exact HTTPS redirect URI, including port and path. Buffer requires HTTPS even for localhost.
3. Copy `.env.example` to `.env` and populate it. Environment files are ignored by Git. Generate independent 32-byte encryption and cookie keys using the command shown in the example.
   Set the real deployment operator name, support email, and privacy email; Gabel refuses to start without them so draft legal/contact pages cannot silently publish placeholders.
4. Create a trusted or locally trusted development certificate and set `TLS_KEY_PATH` and `TLS_CERT_PATH`.
5. Run `npm install`, `npm test`, and `npm start`. The start scripts load the Git-ignored local `.env` file directly.
6. Visit the configured HTTPS origin. Authorize Buffer, run discovery, and prepare an edit only against a disposable user-controlled scheduled post.

The database is created on first start. Tokens and the PKCE verifier are encrypted with AES-256-GCM. Session identifiers and OAuth state are stored only as hashes. Do not rotate `APP_ENCRYPTION_KEY` without a credential re-encryption plan; losing it requires users to reauthorize.

## Safe edit procedure

An edit requires two separate POST actions. Preparation fetches the latest post, checks that every existing asset can be reconstructed from documented fields, builds the complete ordered asset list, and records a fingerprint. The review screen exposes the sanitized before-state and intended list. Confirmation requires typing `EDIT POST <post-id>`. Immediately before mutation, Gabel fetches the post again and aborts on any change. It sends only `id` and `assets`, deliberately omitting scheduling and text fields. It then refetches and compares schedule, publishing mode, text, channel, and media. A network failure after mutation or failed verification is reported as ambiguous.

Gabel does not probe replacement URLs in Phase 1. The operator must provide stable, direct, public HTTPS URLs as required by Buffer.

## Compliance gate

The current gate report is in `docs/COMPLIANCE-PRIVACY-SECURITY-ACCESSIBILITY-GATE.md`. It is not a legal-compliance certification. Production and the next build phase remain blocked on the items marked FAIL or NOT TESTED, including qualified legal review, real operator contact configuration, live Buffer testing, manual accessibility testing, and infrastructure review.
