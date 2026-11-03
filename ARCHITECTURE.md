# Gabel architecture

Created: 2026-11-02 from inspection of the current repository. This is a present-state description, not historical design evidence.

## Runtime

Gabel is a Node.js 24 TypeScript HTTPS server with server-rendered HTML and SQLite persistence. It has no runtime npm packages.

## Components

- `src/server.ts`: HTTPS routes, sessions, CSRF enforcement, OAuth callback, discovery, account controls, edit review/confirmation, and evidence UI.
- `src/oauth.ts`: Buffer authorization URL, state, PKCE, and scope selection.
- `src/buffer.ts`: token exchange/refresh, GraphQL transport, pagination, Buffer error classification, discovery, and post retrieval.
- `src/edit.ts`: lossless asset input reconstruction, thumbnail-safe image replacement, edit intents, stale-state guard, assets-only mutation, and fresh verification.
- `src/replacement-validation.ts`: fail-closed pre-intent and pre-mutation replacement checks using the pinned media probe, live Buffer channel/schema identity, verified X limits, short-lived evidence, and bounded-prefix change detection.
- `src/security.ts`: AES-256-GCM encryption, hashing, signatures, sanitization, and hashed evidence summaries.
- `src/media-security.ts`: public-HTTPS destination validation and bounded availability probing with DNS-address pinning, redirect revalidation, header/timeout limits, total-size derivation, and a maximum 64 KiB inspection prefix used only for signature and dimensions (never persisted or logged).
- `src/db.ts`: tenant-scoped SQLite operations, cascaded deletion, data minimization, and retention purge.
- `src/views.ts` and `src/legal.ts`: accessible document shell and draft legal pages.
- `migrations/001_initial.sql`: current schema.
- `test/foundation.test.ts`: isolated automated tests using mocks where external Buffer behavior is involved.

## Trust boundaries

The browser receives signed session/CSRF cookies but never Buffer credentials. Buffer OAuth and GraphQL calls occur server-side. Tokens and the PKCE verifier are encrypted at rest. Tenant IDs scope connection, cached data, edit intents, media-check authorization, and evidence access. User-supplied replacement URLs must pass the pinned SSRF-safe media checker, supported MIME/signature checks, verified destination-channel format/size/dimension limits, and short-lived change detection before an edit intent is prepared and again before mutation. User-requested media checks make bounded requests for headers plus at most a 64 KiB inspection prefix, retaining only derived signature, dimensions, size metadata, and a prefix digest; Buffer ultimately retrieves media referenced in an edit.

## Known operational boundary

The repository contains application code only. Production secret management, backups, log aggregation, outbound network policy, deployment topology, and live Buffer credentials are not supplied or verified.
