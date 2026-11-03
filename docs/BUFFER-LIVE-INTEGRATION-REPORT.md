# Buffer live integration report

Audit date: 2026-11-02. This report separates source inspection, isolated automated tests, and authentic Buffer operations. It is not a legal-compliance or production-readiness certification.

## 1. Repository baseline

Before phase changes, `npm.cmd run typecheck` passed and `npm.cmd test` passed 26/26 tests. `npm.cmd audit --json` returned zero known advisories. `npm.cmd run lint` and `npm.cmd run integration` failed because those scripts do not exist. The seven required project documents and a Serial Hackathon Winner Playbook were not present. The documents now at the repository root describe current behavior only and do not claim to have guided earlier work.

## 2. Documentation references checked

The official Buffer developer documentation was accessed on 2026-11-02: [overview](https://developers.buffer.com/), [authentication](https://developers.buffer.com/guides/authentication.html), [building apps](https://developers.buffer.com/guides/building-apps.html), [posts and scheduling](https://developers.buffer.com/guides/posts-and-scheduling.html), [hosting media](https://developers.buffer.com/guides/hosting-media.html), [EditPostInput](https://developers.buffer.com/types/EditPostInput.html), [error handling](https://developers.buffer.com/guides/error-handling.html), and [API limits](https://developers.buffer.com/guides/api-limits.html).

Verified documentation facts include authorization code with mandatory PKCE, exact HTTPS redirect URIs, rotating single-use refresh tokens, `https://api.buffer.com` GraphQL, cursor pagination, post/asset fields, `editPost`, assets-list ordering, typed and top-level errors, and 429/`Retry-After` handling. The documented current edit capability is `updatePost`; Gabel was corrected to require it.

## 3. Implemented integration capabilities

| Classification | Capability |
|---|---|
| VERIFIED AUTOMATED | PKCE/state, encrypted credentials, one-time OAuth state, tenant scoping, in-process refresh serialization, rotated-token persistence, GraphQL errors/rate limits, cursor pagination, empty accounts, minimized sync cache, deletion/disconnect, edit confirmation/stale detection, field preservation, SSRF/redirect controls, accessibility checks |
| VERIFIED LIVE | Stored authorization can refresh and retrieve the authentic Buffer account identity and organizations without exposing credentials |
| IMPLEMENTED BUT UNTESTED | Live channel/post data display for non-empty accounts; real media-field variations; real `editPost` mutation and fresh after-state comparison |
| DOCUMENTED ONLY | Remote grant revocation through Buffer settings; production jurisdiction/legal conclusions; multi-instance refresh coordination requirement |
| BLOCKED | Live scheduled-post/media/edit acceptance gate because the connected account returned no channels and no scheduled posts |

Architecture: Node.js 24 TypeScript HTTPS server, server-rendered HTML, SQLite, native `fetch`/DNS/HTTPS, and no runtime npm package. Buffer credentials remain server-side and AES-256-GCM encrypted at rest.

## 4. Automated test results

Final result on 2026-11-02: `npm.cmd run typecheck` passed. `npm.cmd test` passed 29/29, with zero failures, skips, or todos. Covered controls include all applicable requested cases: OAuth state/PKCE, encryption, concurrent refresh, GraphQL errors, pagination, empty accounts, missing asset fields, edit payload/field preservation, cross-account denial, explicit edit authorization, ambiguous outcomes, rate limits, network errors, SSRF, DNS rebinding-style redirect protection, bounded redirects, deletion, keyboard structure, and contrast calculations.

No integration-test or lint script exists, so their final commands exited 1 with `Missing script` and remain NOT TESTED rather than passed. Automated accessibility checks do not replace manual keyboard, screen-reader, zoom/reflow, and visual contrast review. Final `npm.cmd audit --json` returned zero known vulnerabilities across three installed dependencies; this is a point-in-time result, not a guarantee.

## 5. Live OAuth status

VERIFIED LIVE for continued use of the stored encrypted authorization: the read-only verifier successfully refreshed/accessed Buffer and the returned account identity matched the stored connection. The interactive browser authorization redirect/callback was not replayed during this phase. Existing stored evidence includes earlier OAuth success events, but those are prior stored records rather than independently observed browser-flow evidence in this run.

## 6. Live account retrieval status

VERIFIED LIVE at `2026-11-02T16:11:57.041Z`: account identity matched; one organization was returned. Output was deliberately limited to booleans and counts. IDs, credentials, post text, and URLs were not printed.

## 7. Live scheduled-post retrieval status

VERIFIED LIVE query execution, with a genuine empty result: zero channels and zero scheduled posts. Pagination is VERIFIED AUTOMATED but could not be exercised live with an empty collection. No fixture is presented as live evidence.

## 8. Live media discovery status

BLOCKED. The live account returned zero scheduled posts and therefore zero assets. Source, thumbnail, image/video/document metadata, URL longevity, Buffer hosting, and external accessibility could not be evaluated live. The read-only run performed zero media probes.

## 9. Live editPost status

BLOCKED and intentionally not attempted. There is no user-controlled disposable scheduled post and no specific explicit approval for a reviewed mutation. The verifier reports `mutationSent: false`. The app implements a fresh read, scheduled-status plus `updatePost` capability gate, complete ordered asset reconstruction, a ten-minute intent, exact `EDIT POST <id>` confirmation, fresh stale-state check, assets-only mutation, error/ambiguity classification, and fresh after-read.

## 10. Before-and-after verification results

No live before/after result exists. VERIFIED AUTOMATED comparisons detect changes to due time, scheduling/share modes, text, channel, metadata, tags, and the complete asset list. Mutation acceptance alone is not treated as proof. A network/GraphQL/HTTP uncertainty is recorded as ambiguous.

## 11. Security findings

- No secrets or signed media URLs were written to this report or verifier output.
- Media probes allow only standard-port HTTPS, reject URL credentials and prohibited IPv4/IPv6 ranges, resolve all addresses, pin a validated address for the connection, re-resolve every redirect, cap redirects/time/header size, and inspect at most a 64 KiB prefix for signature and dimensions. The prefix and URLs are not displayed or retained outside a short-lived edit intent's required asset list.
- Cached post data is minimized to scheduling metadata and asset count; post text and URLs are not kept in the sync cache.
- Cached-post ownership is tenant/connection scoped before a media check. Buffer reads and edit intents are similarly scoped.
- Refresh serialization is process-local. The database compare-and-swap refuses a late rotation, but horizontally scaled production needs a distributed per-connection lock before requesting a single-use refresh token. Until then, operate a single application process.
- Buffer documentation does not expose a programmatic revocation endpoint in the reviewed material. Local disconnect deletes credentials/cache; the user must revoke the grant in Buffer settings.
- Operator/support/privacy environment values are missing from the inspected `.env`, so the main server correctly refuses to start until truthful contact values are configured.

## 12. Known API limitations

Media URL presence and public reachability do not guarantee Buffer can fetch at publication time or that a social platform will accept/publish content. Signed or expiring URLs may later fail; Buffer recommends stable public URLs. Asset fields differ by type, and Gabel refuses edits when it cannot reconstruct documented required metadata without loss. API schemas, rate limits, channel capabilities, and platform behavior may change.

## 13. Outstanding blockers

1. The connected Buffer account has no channels or scheduled posts.
2. No user-controlled disposable scheduled media post has been identified.
3. No reviewed live edit has explicit approval.
4. Live media field/accessibility behavior and live before/after preservation are unverified.
5. Production contact values, manual accessibility testing, legal review, operational key management/backups/incident response, and multi-instance refresh locking remain open.

## 14. Required user actions

In Buffer, connect the intended social channel and manually create one disposable scheduled post owned/controlled by the tester, with non-sensitive copy, at least one stable public HTTPS media asset, and a due time far enough in the future to avoid publication during testing. Then run Gabel's sync, review the exact post and intended replacement, and provide explicit approval for that one edit. Do not send tokens, client secrets, post text, or signed media URLs in chat.

Configure truthful `OPERATOR_NAME`, `SUPPORT_EMAIL`, and `PRIVACY_EMAIL` values before running the web server. Arrange qualified legal review and manual accessibility testing before production use.

## 15. Final feasibility recommendation

**CONDITIONAL GO for the next controlled integration-verification step; NO-GO for production or a claim that the competition acceptance gate is complete.** Secure live account access is proven and the applicable local controls pass automated tests. The mission's live scheduled-post retrieval, media discovery, explicitly approved edit, and fresh before/after preservation evidence remain blocked by the empty Buffer account state and required user approval. No next phase has been started.

## Compliance-gate addendum reconciliation

Later on 2026-11-02, the compliance addendum re-executed and inspected the test suite, expanded it to 31 passing unit tests, and added 3 passing isolated SQLite integration tests for disconnect, deletion, and retention. Adversarial SSRF testing initially found a bracketed IPv6 literal normalization defect; the defect was fixed and the full unit/type/integration suites then passed. Manual accessibility, truthful operator contacts, qualified legal review, production infrastructure/egress review, and the missing repository playbook remain release blockers. The production compliance gate remains FAILED; this does not change the controlled-integration recommendation or begin another phase.

## Controlled live Buffer verification attempt — 2026-11-02

At `2026-11-02T16:23:49.244Z`, the existing sanitized read-only verifier used the stored encrypted Buffer connection. The authentic account identity again matched the stored connection. Buffer returned one organization, zero channels, zero scheduled posts, and zero assets. No media URL was requested and `mutationSent` was `false`.

The phase stopped at its Step 1 condition. Because no scheduled post exists, Gabel could not inspect a controlled post, classify live media accessibility, prepare a post-specific edit, request approval for an exact change, execute `editPost`, or produce a live before/after comparison. No fixture or invented record was substituted.

The latest automated evidence remains the immediately preceding addendum run: TypeScript PASS, 31/31 unit tests PASS, and 3/3 isolated integration tests PASS. Those commands were not rerun during this stopped live attempt and are not represented as new live evidence.

Required prerequisite: the user must connect the intended Buffer channel and manually create one disposable, user-controlled scheduled post with non-sensitive copy, at least one stable public HTTPS media asset, and a publishing time far enough in the future for controlled testing. The Serial Hackathon Winner Playbook also remains an unresolved documentation dependency because it is not present in the repository and was not supplied. Production compliance remains FAILED. No deployment or phase advancement occurred.

### Readiness retry after reported setup

At `2026-11-02T16:31:03.257Z`, Gabel independently repeated the authentic read-only discovery. Account identity still matched and one organization was returned, but the response again contained zero channels, zero scheduled posts, and zero assets. No media check or mutation ran. The controlled phase therefore remains blocked at Step 1. The user must confirm that the connected channel and a scheduled—not draft or already sent—disposable media post exist in the same Buffer account/organization authorized to Gabel.

### Successful discovery after screenshot evidence

The user later supplied screenshot evidence of one X channel, one queued post, and zero sent posts. Screenshot facts were treated as user-provided visual evidence until independently confirmed.

At `2026-11-02T17:00:18.298Z`, authentic read-only API discovery returned one organization, one channel, one scheduled post, and one image asset. At `2026-11-02T17:01:52.869Z`, a fresh sanitized read confirmed that the API organization/channel names matched the screenshot-provided names, without emitting provider identifiers. The post was `scheduled` for `2026-11-10T14:00:00.000Z`, was associated with the discovered channel, allowed `updatePost`, contained text, and used custom/automatic scheduling.

The post contains one JPEG image. Source, thumbnail, and image metadata fields are present. The image has no alt text, animated thumbnail, or user tags. The complete ordered asset list can be reconstructed from documented fields.

One bounded media probe ran through Gabel's DNS/address validation, pinned request, timeout, redirect, header, and no-body-download controls. It followed zero redirects and returned a network error: `Media host could not be reached within the safety limits`. Classification: **INCONCLUSIVE**. It is not evidence of inaccessibility and cannot predict Buffer publication.

An assets-only replacement is technically supported for this post. No edit intent was created because the user has not provided a stable public HTTPS replacement image URL. Gabel did not invent a URL, reuse the existing source as a no-op, expose the current URL, or send a mutation. Once a replacement is supplied and validates safely, the proposed change will replace only asset position 0's source while preserving documented image metadata/order; text, scheduled time, scheduling mode, and channel will be omitted from the mutation and verified by fresh before/after reads.

Current automated results after the verifier change: TypeScript PASS, 31/31 unit tests PASS, and 3/3 isolated integration tests PASS. Production compliance remains FAILED. No deployment or phase advancement occurred.

### Replacement URL validation attempt

The user supplied a candidate replacement image URL. Gabel's bounded SSRF-protected checker accepted it far enough to attempt a pinned HTTPS request, followed zero redirects, and returned `error`: `Media host could not be reached within the safety limits`. Classification: **INCONCLUSIVE**. The URL is not reproduced in this report. Because the required reachable validation did not succeed, Gabel did not create an edit intent, request mutation approval, or send any mutation.

