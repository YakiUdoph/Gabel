# Phase 1 feasibility report

Report date: 2026-10-23 (Atlantic/Cape Verde)

## Recommendation: CONDITIONAL GO

The documented API surface is sufficient for account/channel discovery, cursor-paginated scheduled-post retrieval, reading asset source URLs, and whole-list media replacement through `editPost`. The implementation and isolated automated tests are complete. Live feasibility remains unproven because this repository was supplied without a registered Buffer client, credentials, authorization, or a user-controlled test post. Under the project stop conditions, monitoring and automatic repair have not been implemented.

## Capability status

| Capability | Status | Evidence |
|---|---|---|
| OAuth Authorization Code + PKCE | Documented; implemented; not live-tested | Official auth guide; isolated state/PKCE tests |
| Refresh-token rotation | Documented; implemented; not live-tested | Single-use rotation is serialized in-process and guarded by DB token version |
| Organizations and channels | Documented; implemented; not live-tested | Official account/channels queries |
| Scheduled posts and pagination | Documented; implemented; not live-tested | `status: [scheduled]`, `first`/`after`, `pageInfo` |
| Media source and thumbnail URLs | Documented; implemented; not live-tested | `Asset.source`, `Asset.thumbnail`, typed metadata |
| Edit scheduled-post assets | Documented; implemented behind explicit confirmation; not live-tested | `EditPostInput.assets` replaces ordered list; schedule fields omitted |
| Schedule preservation | Documented behavior; automated comparison implemented; not established live | A live before/after test is mandatory before Phase 2 |

## Documentation observations

- Buffer currently requires PKCE for all OAuth clients. `offline_access` is necessary for a refresh token.
- Refresh tokens are single-use. Successful refresh must atomically replace both tokens; reuse of an old token revokes the grant.
- The GraphQL guide says application errors may be returned with HTTP 200, either in top-level `errors` or as typed mutation errors. The transport checks both.
- Current `EditPostInput` documentation says omitting `mode`, `dueAt`, and `schedulingType` preserves scheduling. The mutation intentionally omits all three and verification still compares them.
- Current asset output exposes a `source` URL. This is evidence that a URL is available, not evidence of its hosting origin, permanence, or current reachability.
- Documents require title and thumbnail URL on input. If those cannot be recovered from output, Gabel refuses to edit rather than dropping fields.
- Video input explicitly rejects custom `thumbnailUrl`; Gabel preserves documented video metadata (`thumbnailOffset`, `title`) and does not pass the output thumbnail as input.
- No documentation-versus-live discrepancy can be assessed until authorization and live calls occur.

## Live evidence ledger

Successfully completed live operations: none.

Attempted but unsuccessful live operations: none.

Not yet tested: OAuth redirect/callback, token refresh, organization/channel retrieval, scheduled-post retrieval, actual asset shapes by service, `editPost`, post-edit refetch, schedule preservation, rate-limit headers, and revocation behavior.

Request identifiers and sanitized responses: none available. The running app records sanitized operation summaries and request IDs when Buffer supplies them at `/evidence`; it never stores tokens in evidence records.

## Blockers and stop condition

Primary blocker classification: **missing configuration and missing authorization**. Required inputs are a registered Buffer app client, exact HTTPS redirect URI, client credentials, a real authorizing account, and a disposable user-controlled scheduled media post. Because real OAuth, retrieval, media availability, editing behavior, and schedule preservation are not yet verified, Phase 2 must not begin.

To change the recommendation to GO, complete the live checklist in order and retain sanitized evidence:

1. Authorize a test account and verify the granted scopes.
2. Retrieve organizations, genuine channels, and every scheduled-post page.
3. Confirm media fields for the target service and identify any fields that cannot be reconstructed.
4. Prepare and review a change on a disposable scheduled post.
5. Explicitly confirm it, then verify the retrieved asset list, `dueAt`, `shareMode`, `schedulingType`, text, and channel.
6. Record any schema or behavior discrepancy and rerun the relevant tests before review.

## 2026-11-13 current-state addendum

The earlier hosting/configuration blocker is resolved: Gabel is publicly deployed on Vercel with durable Neon PostgreSQL and the exact production callback. Automated and public acceptance evidence covers the platform, database, session, OAuth-state, and route boundaries. Fresh interactive Buffer OAuth remains a required account-owner action; no new live mutation is authorized, and no phase is advanced automatically.
