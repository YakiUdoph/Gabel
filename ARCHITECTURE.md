# Gabel architecture

Created: 2026-11-02 from inspection of the current repository. This is a present-state description, not historical design evidence.

## Runtime

Gabel is a Node.js TypeScript application with server-rendered HTML and two supported runtimes. Local/Docker execution uses the standalone HTTPS listener and SQLite. Vercel execution exports the same request handler as a Node.js Function, lets Vercel terminate HTTPS, and uses managed Neon PostgreSQL through the serverless driver.

## Components

- `api/index.ts` and `vercel.json`: Vercel Function entrypoint, bounded duration, `iad1` placement, and original-path-preserving routing.
- `src/server.ts`: shared request handler plus local-only HTTPS bootstrap; routes, sessions, CSRF enforcement, OAuth callback, discovery, account controls, edit review/confirmation, and evidence UI.
- `src/oauth.ts`: Buffer authorization URL, state, PKCE, and scope selection.
- `src/buffer-authorization.ts`: required-scope validation, expected-account verification, and token-version-fenced connection/reconnection persistence.
- `src/buffer.ts`: token exchange/refresh, durable per-connection refresh coordination, fenced token rotation, GraphQL transport, pagination, Buffer error classification, discovery, and post retrieval.
- `src/edit.ts`: lossless asset input reconstruction, thumbnail-safe image replacement, atomically claimed single-use edit intents, stale-state guard, assets-only mutation, and fresh verification.
- `src/replacement-validation.ts`: fail-closed pre-intent and pre-mutation replacement checks using the pinned media probe, live Buffer channel/schema identity, verified X limits, short-lived evidence, and bounded-prefix change detection.
- `src/security.ts`: AES-256-GCM encryption, hashing, signatures, sanitization, and hashed evidence summaries.
- `src/media-security.ts`: public-HTTPS destination validation and bounded availability probing with DNS-address pinning, redirect revalidation, header/timeout limits, total-size derivation, and a maximum 64 KiB inspection prefix used only for signature and dimensions (never persisted or logged).
- `src/db.ts`: tenant-scoped SQLite operations, durable edit/refresh claims, compare-and-swap credential writes, cascaded deletion, data minimization, and retention purge.
- `src/postgres-db.ts`: serverless PostgreSQL persistence with equivalent tenant, encryption, cascade, retention, OAuth-state, token-fencing, and edit-claim guarantees.
- `migrations/postgres/001_initial.sql`: PostgreSQL schema and constraints for Vercel production.
- `src/views.ts` and `src/legal.ts`: accessible document shell and draft legal pages.
- `migrations/001_initial.sql`, `migrations/002_concurrency_hardening.sql`, and `migrations/003_buffer_reauthorization.sql`: base schema, durable concurrency claims, and tenant/session-bound reconnect context.
- `test/foundation.test.ts`: isolated automated tests using mocks where external Buffer behavior is involved.

## Trust boundaries

The browser receives signed session/CSRF cookies but never Buffer credentials. Buffer OAuth and GraphQL calls occur server-side. Tokens and the PKCE verifier are encrypted at rest. Tenant IDs scope connection, cached data, edit intents, edit claims, media-check authorization, and evidence access. Reauthorization stores one-time reconnect context against the authenticated browser session, expected connection, and expected token version. The callback retrieves the live Buffer account identity and must match the stored account before a compare-and-swap can replace encrypted credentials; cached tenant data and evidence are not deleted. An exact approval is atomically claimed once in SQLite before fresh validation, and the claim is fenced before the mutation attempt. Token refresh uses a durable per-connection claim plus token-version compare-and-swap; a started or uncertain single-use refresh is never replayed automatically, and its stale response cannot overwrite a completed reauthorization. User-supplied replacement URLs must pass the pinned SSRF-safe media checker, supported MIME/signature checks, verified destination-channel format/size/dimension limits, and short-lived change detection before an edit intent is prepared and again before mutation. User-requested media checks make bounded requests for headers plus at most a 64 KiB inspection prefix, retaining only derived signature, dimensions, size metadata, and a prefix digest; Buffer ultimately retrieves media referenced in an edit.

## Production topology

The public Vercel deployment uses Vercel Secret/Config variables and a connected Neon free-plan database. Functions are stateless; sessions, OAuth state, encrypted credentials, claims, cache records, and evidence are durable PostgreSQL records. Local/Docker SQLite remains the rollback/reference implementation.

## Known operational boundary

Provider backup/restore evidence, qualified legal review, manual assistive-technology review, and fresh interactive production Buffer authorization remain operator responsibilities outside automated repository verification.
