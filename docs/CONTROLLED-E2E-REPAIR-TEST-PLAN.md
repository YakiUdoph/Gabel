# Controlled end-to-end media-repair test plan

Design date: 2026-11-02 (Atlantic/Cape Verde). This is a plan, not execution evidence. No post, edit intent, approval request, Buffer mutation, deployment, or phase advancement occurred.

The seven project documents, compliance gate, current live-integration report, connectivity report, implementation, and tests were inspected. No Serial Hackathon Winner Playbook exists in the repository; its unavailable contents are not claimed or reconstructed.

## A. Feasibility

The test is feasible with a separate user-controlled scheduled post and a user-controlled public media origin. It must not use or modify the existing scheduled post, whose image is not confirmed broken.

Evidence classifications:

- **LIVE READ-ONLY:** the connected Buffer GraphQL schema exposes `createPost`, `editPost`, and `deletePost`; `CreatePostInput`, `EditPostInput`, and `DeletePostInput` have the fields documented by Buffer. No mutation was sent.
- **LIVE NETWORK:** Gabel's actual pinned checker classified a public HTTP 404 endpoint as `unreachable`, with one DNS lookup, three public IPv4 answers, successful HTTPS far enough to receive HTTP 404, zero redirects, and no error category. This is distinct from the restricted-environment attempt, which returned `error/other` and was not treated as media failure.
- **IMPLEMENTED AND AUTOMATED:** tenant-scoped discovery, media probing, edit eligibility, complete ordered-asset reconstruction, ten-minute intents, exact confirmation, stale-state rejection, assets-only `editPost`, ambiguous transport handling, fresh refetch, and unrelated-field comparison.
- **DOCUMENTED ONLY:** creation of an image post via `createPost`, scheduling with `customScheduled`/`dueAt`, and cleanup via `deletePost` are supported by official Buffer documentation but are not implemented as Gabel application routes and have not been executed for this test.

## B. Required setup

1. Use a dedicated, non-sensitive JPEG on a user-controlled HTTPS origin. The URL must be public without authentication or signing, direct, and dedicated to this test.
2. The origin must allow the user to remove only that object or change only that path to a deterministic HTTP 404 or 410 while keeping its DNS name, public IP routing, and valid TLS certificate unchanged.
3. Configure a short or disabled CDN cache for the test object so removal can be observed promptly. Do not use DNS removal, TLS breakage, firewall blocking, a private redirect, or an induced timeout; those produce unsafe or inconclusive evidence rather than a confirmed remote HTTP failure.
4. Create a separate scheduled X post with non-sensitive test text clearly identifying it as disposable, exactly one test image, and a custom publication time comfortably in the future. Use a hard cleanup deadline well before publication.
5. Keep the already validated JPEG candidate available as the replacement, but revalidate it immediately before preparing any future edit.

The safest current creation path is for the user to create the disposable post manually in Buffer. Gabel has no `createPost` route. A programmatic creation would be a new mutation capability and requires separate implementation review and explicit authorization.

## C. Real Buffer API operations

The planned sequence is:

1. `createPost` — only after separate authorization if performed programmatically; input would use the selected channel, `schedulingType: automatic`, `mode: customScheduled`, a future `dueAt`, non-sensitive text, and one image asset. The manual Buffer UI is preferred with the current codebase.
2. Scheduled-post discovery and `post` retrieval — read-only; confirm the new post is distinct, scheduled, on the intended channel, has one image, and exposes `updatePost`.
3. Direct media probe through Gabel — not a Buffer operation; establish the initial reachable baseline.
4. Fresh `post` retrieval during intent preparation — read-only.
5. Fresh `post` retrieval immediately before confirmation — read-only stale-state guard.
6. `editPost` — one assets-only mutation after exact approval; omit text, schedule, mode, publishing type, channel, tags, and service metadata.
7. Fresh `post` retrieval — read-only verification of the actual stored result and preservation of unrelated fields.
8. `deletePost` — optional but recommended cleanup, separately authorized or performed manually by the user after evidence is captured.

Official references: Buffer's `CreatePostInput`, scheduled-post example, image-post example, hosting-media guide, `EditPostInput`, and GraphQL reference for `deletePost`.

## D. Controlled failure method

The initial test asset must first pass Gabel's checker as `reachable`: public DNS/IPs, valid TLS, HTTP 2xx, supported content type and signature, dimensions, and size.

After Buffer confirms the separate post and asset, the user removes only the test object or changes only that path to 404/410. Two fresh Gabel checks should then return the same non-2xx status while DNS remains public and HTTPS still reaches the host. A separate known-good public control should remain reachable during the same window.

Classification rule:

- HTTP 404/410 after public DNS and valid HTTPS: **CONFIRMED REMOTE MEDIA FAILURE** (`unreachable`).
- DNS, socket/network, TLS, or timeout failure: **INCONCLUSIVE** (`error` plus sanitized category); do not prepare a repair solely from this result.
- Private/reserved destination or unsafe redirect: **BLOCKED BY POLICY** (`unsafe`); do not proceed.
- HTTP 2xx with unsupported or mismatched media: **REACHABLE BUT MEDIA-INVALID**; do not conflate it with connectivity.

## E. End-to-end procedure and expected evidence

1. **Creation:** after authorization, create the separate scheduled post. Record a sanitized post hash, scheduled status, channel match, asset count, and `updatePost` capability; never record text, provider IDs, or URLs in project reports.
2. **Initial accessibility:** record `reachable`, HTTP status, DNS/public-address counts, TLS success inferred from the verified HTTPS response, redirects, MIME/signature agreement, dimensions, total size, and duration.
3. **Controlled unavailability:** user changes only the dedicated asset path to HTTP 404/410.
4. **Detection:** require two matching `unreachable` checks plus a reachable control endpoint. Any `error` result stops as inconclusive.
5. **Replacement validation:** rerun the actual pinned checker on the replacement and recheck current Buffer/X format and size compatibility.
6. **Preview:** show the disposable post only; original and replacement media positions; complete intended asset list; and exact preservation claims for text, due time, channel, publishing mode/type, tags, metadata, and unrelated assets. No mutation has been sent at this point.
7. **Approval:** require the existing exact `EDIT POST <id>` confirmation for the reviewed, unexpired intent. Approval is single-use and post-specific.
8. **Edit:** refetch, abort if the fingerprint changed, then send one assets-only `editPost` mutation.
9. **Refetch:** retrieve the same post from Buffer after the mutation response. A transport or refetch failure is ambiguous, never success.
10. **Verification:** compare the complete actual asset list to the intended list and confirm text, due time, share mode, scheduling type, channel, metadata, and tags are unchanged. Probe the replacement source again. Record success only if both Buffer state and media reachability match the plan.
11. **Cleanup:** with separate authorization, delete the disposable post before the hard deadline and verify it is absent. Cleanup failure is reported and escalated before publication time.

## F. Risks and safeguards

- Accidental publication: schedule comfortably in the future, set a hard cleanup deadline, monitor post status, and stop if the remaining safety window becomes too short.
- Wrong-post mutation: use a uniquely identified disposable post, tenant-scoped retrieval, fresh `updatePost` capability, exact confirmation, and a stale fingerprint guard.
- False failure from environment policy: require deterministic HTTP 404/410 and a simultaneous reachable control; DNS/TLS/network/timeouts remain inconclusive.
- CDN delay: use an isolated path with short caching and require repeated fresh checks.
- External-media persistence: use no sensitive content; the asset is intentionally public.
- Ambiguous Buffer result: do not retry automatically; refetch first and report ambiguity.
- Unrelated-field loss: send the complete ordered asset list but omit unrelated top-level fields; verify all protected fields afterward.
- Publication success is not part of this test and must not be claimed.

## G. Required user authorizations

Separate authorization is required for each state-changing action:

1. Creating the disposable scheduled post, if Gabel or an operator performs it. The user may instead perform this directly in Buffer.
2. Making the dedicated initial asset unavailable, if an operator controls the host. The user may instead perform this directly.
3. Creating an edit intent after reviewing the confirmed-failure and replacement evidence. This task does not request that authorization.
4. Executing the exact `editPost` mutation through the existing confirmation phrase.
5. Deleting the disposable Buffer post during cleanup, if not performed directly by the user.
6. Restoring or deleting any externally hosted test asset if that action affects user-owned infrastructure.

No approval is inferred from approval of another step.

## H. Remaining blockers

1. No user-controlled, independently revocable initial test-asset URL or hosting control has been established.
2. No authorization to create a disposable scheduled post has been given, and this plan does not request it.
3. Gabel does not implement `createPost` or `deletePost`; those steps must be manual unless separately built, tested, reviewed, and approved.
4. At plan-design time, `assetToInput()` carried the original image's `thumbnailUrl` into the intended replacement asset. Buffer documents that `thumbnailUrl` is optional and must be publicly reachable when supplied. Section J records the later correction and automated evidence without rewriting this original finding.
5. At plan-design time, `EditService.prepare()` validated destination policy but did not require a fresh successful media probe or format/size compatibility evidence. Section J records the later fail-closed preparation and confirmation gates.
6. At plan-design time, the media-check UI exposed technical outcomes (`reachable`, `unreachable`, `unsafe`, `error`) instead of explicit user-facing result labels. Section J records the later presentation correction.
7. The replacement host's future availability and Buffer's eventual publication cannot be guaranteed. The test ends at verified stored post state and fresh reachability, not publication.
8. The Serial Hackathon Winner Playbook remains unavailable. Production compliance blockers remain unchanged.

## I. Decision

**CONDITIONAL GO for test setup design; NO-GO for execution now.** The Buffer operations and failure signal are technically feasible, and the genuine HTTP-failure distinction is verified. Execution remains blocked by the missing controlled initial asset, missing state-change authorizations, and the replacement-thumbnail/preparation-gate issues above.

Production compliance remains **FAILED**. No phase is advanced.

## J. Repair-preparation safeguard update (2026-11-03)

The implementation blockers identified in items H.4-H.6 are now resolved with **VERIFIED AUTOMATED** evidence. Replaced images omit the original image thumbnail; untouched assets retain their documented inputs and order. Intent preparation now requires a fresh successful run of Gabel's pinned checker, matching JPEG/PNG MIME and signature, a known positive size, known dimensions, live Buffer media-format recognition, and the verified X static-image limits of 5 MB and 8192 by 8192 pixels. Unresolved destination requirements fail closed.

The same replacement is checked again immediately before mutation. Gabel rejects expired evidence, a changed post fingerprint, or a changed bounded-prefix/media fingerprint before sending `editPost`. The prefix check is not a complete-file corruption check and no future availability or publication is promised. The UI now distinguishes **CONFIRMED PROBLEM**, **COULD NOT VERIFY**, **UNSUPPORTED FILE**, and **READY**.

This update does not execute the plan or change its authorization requirements. The controlled test remains **NO-GO for execution** until its external setup and separate state-change approvals exist. Production compliance remains **FAILED**.
