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

## K. Controlled live repair preparation addendum (2026-11-03)

This addendum is the current runbook. It supersedes the earlier recommendation to prefer a manual Buffer dashboard upload, but it does not rewrite that dated finding. The complete 62-page Serial Hackathon Winner Playbook was accessible at `C:\Users\PC\Downloads\Playbook .pdf` and was read in full for this preparation. The Playbook file remains outside the repository. No state-changing operation was performed.

### K.1 Exact preparation status

- **PREPARATION COMPLETE / DOCUMENTED:** the asset topology, disposable-post contract, checkpoints, stop conditions, authorization boundaries, evidence fields, and cleanup deadline are defined below.
- **VERIFIED AUTOMATED:** current Gabel tests cover tenant isolation, bounded SSRF-safe media probing, JPEG/PNG replacement validation, complete ordered-asset reconstruction, exact single-use edit approval, fresh-state rejection, one assets-only edit call, ambiguous-outcome handling, and fresh post retrieval/comparison. Mocked tests are not live evidence.
- **VERIFIED LIVE READ-ONLY:** existing sanitized reports record authenticated Buffer account, organization, channel, scheduled-post, asset, capability, and schema reads. They do not prove a live repair.
- **DOCUMENTED:** current official Buffer documentation says API media is supplied as a public URL in the ordered `assets` list, must remain reachable until publication, custom scheduling uses `mode: customScheduled` with `dueAt`, `EditPostInput.assets` replaces the complete asset list when supplied, and `deletePost` accepts a post ID.
- **NOT EXECUTED:** no dedicated host, test image, disposable post, deliberate 404/410, edit, deletion, or cleanup verification exists for this run.
- **DECISION:** **NO-GO to start the controlled test.** The blockers in K.9 must be closed and each state change must receive its own explicit authorization. Production compliance remains **FAILED**.

### K.2 Recommended controllable image host

Use a dedicated Cloudflare Worker hostname owned by the user, backed by a private R2 bucket through an R2 Worker binding. A unique public `workers.dev` hostname is sufficient for this controlled test and avoids requiring a custom domain; a custom domain remains optional. Do not use an R2 `r2.dev` public-bucket URL, a signed URL, a public file-sharing link, DNS removal, certificate breakage, or a third-party image.

The Worker should expose only three unpredictable, non-sensitive test paths:

1. an original image path backed by one R2 object;
2. a replacement image path backed by a different R2 object; and
3. a control image path backed by a third R2 object.

For `GET` and `HEAD`, the Worker should return the stored bytes with the correct `image/jpeg` or `image/png` type, content length, ETag, and `Cache-Control: no-store, max-age=0`. It should honor or safely ignore byte ranges while still returning a valid image response. If the original object is absent, that same original path must return an explicit HTTP `410 Gone` with `Cache-Control: no-store, max-age=0`; the hostname, DNS, route, Worker, and TLS certificate must remain unchanged. Disable Worker entrypoint caching in the reviewed Wrangler configuration and keep the no-store response directives; do not add a rule that overrides them. R2 deletion is strongly consistent through the Worker binding, while the explicit cache disablement and headers avoid stale 200 or negative-cache ambiguity.

Use two user-created, fictional test cards with no third-party marks or copyrighted source material. Recommended dimensions are 1200 x 675, static JPEG or PNG, under 5 MB and under 8192 x 8192; keeping each file below 64 KiB is preferable because Gabel's bounded inspection can then cover the complete small file rather than only its prefix. The original and replacement should be visibly distinct and labeled as disposable test media. The control may be a copy of the replacement under a different object key.

Before Buffer post creation, require two public-network checks of all three paths, including one through Gabel. Each must have public DNS, valid HTTPS on port 443, no redirect, HTTP 200/206, matching MIME and file signature, known positive size, valid dimensions, and no authentication or query-string signature. Record URL hashes, never the URLs themselves, in project evidence.

### K.3 Disposable Buffer post contract

The post must:

- belong to the Buffer organization and connected X channel already authorized to the same Gabel tenant;
- use a channel whose fresh configuration and live `MediaFormat` schema continue to admit the chosen JPEG/PNG;
- be created through Buffer's API with the original external URL explicitly supplied as the sole `assets` image URL, unless an alternative creation route is first proven to preserve that exact external URL;
- use `schedulingType: automatic`, `mode: customScheduled`, and a `dueAt` at least 72 hours after creation;
- contain short fictional text such as `DISPOSABLE GABEL CONTROLLED REPAIR TEST — DO NOT PUBLISH`; no links, people, claims, brands, customer data, or production campaign content;
- have exactly one static image, no thread, no link attachment, no approval workflow, and preferably no tags or service-specific optional settings;
- remain `scheduled`, expose `updatePost`, and be uniquely distinguishable from every existing post without using an existing scheduled post; and
- be safe for the authorized user to delete from Buffer well before publication.

Immediately after creation, a fresh Buffer read must prove that the returned asset source equals the original public URL byte-for-byte, the post has exactly one image, the due time and channel are correct, and the status is `scheduled`. A dashboard upload is not acceptable evidence by itself because the available evidence does not establish that it preserves the externally controlled source URL.

Gabel has no `createPost` route. The creation mechanism therefore remains a pre-run choice: a separately reviewed one-shot server-side API operation using the existing encrypted connection, or a user-controlled official Buffer API client that does not disclose credentials to Gabel output. Do not improvise an ad hoc credential-bearing command during the test. An uncertain create result must not be retried; perform read-only discovery first and reconcile whether the disposable post exists.

### K.4 Hard timeline and cleanup guarantee

- Schedule at least 72 hours ahead.
- Operational target: complete repair evidence and cleanup within two hours of post creation.
- Absolute cleanup deadline: 24 hours before `dueAt`.
- Do not create the post unless the authorized Buffer user is present, can delete it in the Buffer dashboard, and has separately authorized the cleanup action or is ready to perform it personally.
- At every checkpoint, stop and clean up if less than 24 hours remains before `dueAt`, if post status is no longer `scheduled`, or if the cleanup owner becomes unavailable.
- Cleanup is successful only when a fresh scheduled-post API discovery excludes the post ID and the authorized user independently confirms it is absent from Buffer's scheduled queue. Hash the post ID in retained evidence. If either result is missing or contradictory, cleanup is **UNCONFIRMED** and the test is not complete.
- An uncertain delete result must never be retried automatically. First do fresh read-only discovery/direct retrieval and inspect Buffer's dashboard. Any further delete attempt requires a new explicit authorization.

If the host resources are also to be removed, do so only after Buffer-post deletion is confirmed. The original object is already absent by design; removal of the replacement, control, Worker route, or bucket is a separate user-owned infrastructure change and needs its own authorization.

### K.5 Exact live sequence and stop conditions

1. **Preflight:** name the operator and cleanup owner; record UTC and local times, `dueAt`, the absolute cleanup deadline, and authorization status. Stop if cleanup cannot be guaranteed.
2. **Host preflight:** from Gabel and a second independent public-network HTTP client, fetch original, replacement, and control paths. Stop on disagreement, redirect, authentication, non-public routing, TLS/network error, MIME/signature mismatch, unknown size/dimensions, or caching evidence inconsistent with no-store.
3. **Creation authorization:** present the exact channel label, fictional text, due time, and hashed original-URL identity. Obtain explicit authorization for this create only.
4. **Create once:** use the reviewed `createPost` operation. Never retry an uncertain response. On uncertainty, use only read operations to determine whether the post exists.
5. **Fresh original state:** retrieve the post and capture the complete current `POST_FIELDS` projection. Require scheduled status, correct tenant/channel, exact due time/text, exactly one image, exact original source URL, and `updatePost`. Stop on any mismatch.
6. **Initial working proof:** repeat Gabel and independent-client checks of the original; require matching 200/206 image results. Also require the replacement and control to remain ready.
7. **Revocation authorization:** obtain a separate explicit authorization to remove only the original R2 object. Do not alter DNS, TLS, Worker routing, replacement, or control.
8. **Revoke once:** delete only the original object. If deletion outcome is uncertain, stop; do not repeat the delete until read-only object state is reconciled.
9. **Independent failure proof:** within five minutes, perform (a) Gabel's pinned media check and (b) a GET from a separate public-network HTTP client. Both must return the same genuine HTTP 410 (404 is acceptable only if that was the reviewed Worker contract). The control must return 200/206 from both environments in the same window. DNS/TLS/network/timeouts are inconclusive and stop the repair.
10. **Replacement proof:** Gabel must classify the replacement `READY`; the independent client must return 200/206 with the expected content type, size, and digest. Stop on disagreement or if the validation is more than ten minutes old.
11. **Fresh pre-edit state:** retrieve the post again. Require the same fingerprint and protected values as step 5, `scheduled` status, and `updatePost`. Stop if anything changed.
12. **Prepare intent:** create the tenant-scoped Gabel intent for image position zero. Confirm the intended list contains exactly the replacement and does not carry the original thumbnail URL.
13. **Exact review:** show the user the post/channel labels, due time, source and replacement identities, complete one-asset intended list, and a field-by-field preservation table. State clearly that no edit has been sent.
14. **Edit authorization:** require the exact, unexpired `EDIT POST <id>` phrase for this intent. Approval of creation, revocation, or cleanup does not authorize the edit.
15. **One edit attempt:** Gabel refetches the post, rejects a changed fingerprint, revalidates the replacement, and sends one assets-only `editPost`. Never retry a network, HTTP, GraphQL, invalid-response, or verification-lookup uncertainty automatically.
16. **Fresh verification:** fetch the post again. Require the actual source to equal the replacement, the complete reconstructed asset list to equal the reviewed list, and all defined protected fields to match. Probe the replacement again from Gabel and the independent client.
17. **Truthful classification:** report `CONFIRMED` only if the mutation response, fresh Buffer state, protected-field comparison, and replacement probes all agree. Any missing read, discrepancy, or uncertain mutation is `AMBIGUOUS` or `FAILED`, never inferred success.
18. **Cleanup authorization and deletion:** obtain the separate cleanup authorization, delete/cancel the disposable post once, and verify API absence plus dashboard absence before the absolute deadline. Cleanup is required even when the repair failed or was ambiguous.
19. **Host disposition:** retain or remove the public test paths only according to a separately authorized infrastructure-cleanup decision. Never treat host cleanup as proof of Buffer-post cleanup.

### K.6 Protected-field boundary

For this controlled X image post, the protected values are: post ID, tenant/account association, channel ID, `scheduled` status, text, `dueAt`, `shareMode`, `schedulingType`, tags, the retrieved common metadata projection, asset count/order, image metadata (including alt text and user tags when present), and every untouched asset input. The only intended change is asset position zero's source URL; a stale original thumbnail must not be carried forward.

`updatedAt`, Buffer-generated asset IDs, request IDs, and equivalent server-managed mutation metadata are expected to change or are not user-controlled, so they are recorded but not required to remain equal. Gabel currently retrieves only the common metadata projection selected in `POST_FIELDS`; the test must not claim that unselected internal Buffer fields were compared.

The current `comparePost()` checks text, due time, share mode, scheduling type, channel, common metadata, tags, and the reconstructed complete asset list. It does **not** currently compare post `status` after the mutation. Until a scoped automated correction adds that check, step 16 must not rely on `comparison.matches` alone, and this is a release blocker for starting the controlled test.

### K.7 Evidence checklist

Retain only sanitized evidence:

- run ID; UTC timestamps; operator/cleanup roles; evidence classification;
- official schema/document version or retrieval date and live read-only schema outcome;
- hashed tenant, connection, organization, channel, post, and URL identities;
- create request shape with values redacted, Buffer request ID when returned, typed outcome, and fresh creation read;
- original/replacement/control probe roles, HTTP status, public-address count, redirect count, MIME, signature, dimensions, total bytes, bounded digest, duration, and Gabel classification;
- R2 original-object deletion outcome and the two independent post-revocation HTTP outcomes;
- before state and pre-edit state as sanitized hashes/booleans plus the exact field comparison table;
- reviewed intended asset list using hashed URL identities and positions;
- approval events for create, revocation, edit, and cleanup, each with timestamp, scope, actor, matched boolean, and intent/run ID; do not retain the raw confirmation phrase;
- edit request ID, typed mutation outcome, ambiguity classification, and whether any retry occurred (required value: false);
- fresh after state, exact replacement match, protected-field comparison, status check, and post-edit replacement probes;
- delete request outcome, fresh API absence, dashboard absence, cleanup time relative to deadline, and final cleanup classification; and
- every stop condition, discrepancy, missing datum, or inconclusive result.

Never retain bearer/refresh tokens, cookies, client secrets, private URLs, signed query strings, raw post IDs, personal information, raw post text beyond the approved fictional fixture, or screenshots containing those values. Screenshots are optional and may be captured only from sanitized views; none may be invented.

### K.8 Separate authorization points

The user's explicit authorization is required separately for:

1. provisioning/deploying the Worker/R2 host and uploading original, replacement, and control objects;
2. creating the exact disposable Buffer post;
3. deleting the original host object to produce HTTP 410/404;
4. preparing an edit intent if the user treats even short-lived storage of the reviewed URLs/state as a separate operation;
5. executing the exact one-post `editPost` through Gabel's confirmation phrase;
6. deleting/cancelling the disposable Buffer post; and
7. deleting or altering the remaining Worker/R2 test resources.

Read-only Buffer retrieval, schema inspection, and public HTTP checks do not authorize any of these mutations. No authorization carries over to another action.

### K.9 Remaining blockers before start

1. The Worker/R2 host, dedicated `workers.dev` hostname, cache-bypass behavior, three public paths, and original/replacement/control files have not been provisioned or validated.
2. No reviewed creation mechanism exists in Gabel. A one-shot server-side `createPost` operation or user-controlled official API client must be selected and tested without exposing credentials.
3. No disposable Buffer post exists, and no create authorization has been given.
4. `comparePost()` does not yet fail when post status changes after edit; this requires a scoped code/test correction before the run.
5. The cleanup mechanism is manual or external because Gabel has no `deletePost` route. The cleanup owner, separate authorization, and two-source absence verification are not yet established.
6. The target channel, live media enum, replacement asset, and post capability must be revalidated at run time; prior evidence cannot be reused as current proof.
7. Gabel's metadata comparison is limited to fields selected by `POST_FIELDS`; evidence must use the protected-field boundary in K.6 and must not claim comparison of unknown internal fields.
8. No live end-to-end repair, protected-field proof, or cleanup evidence exists. Production compliance remains **FAILED**.

### K.10 Start decision

**NO-GO.** Preparation is complete, but the controlled test must not start until K.9 items 1, 2, 4, and 5 are resolved, the runtime prerequisites in item 6 pass, and the user separately authorizes the applicable state changes. This is not a live-repair completion record and does not advance a phase.

## L. Local blocker-resolution update (2026-11-03)

This update supersedes the local-code blocker status in K.9 without changing any external authorization boundary.

### Post-status verification

`comparePost()` now validates the fresh post identity and Buffer's documented `PostStatus` enum. A verified repair requires both the original and fresh post to be the same post and remain `scheduled`. Missing, unknown, or changed status, missing fresh data, or a changed identity produces a mismatch and leaves the intent ambiguous rather than confirmed. The pre-edit fingerprint continues to compare the complete retrieved projection, including status, before any mutation.

Automated regressions cover unchanged status, changed status, missing status in a partial fresh response, an unknown status, changed identity, GraphQL partial-response rejection, and a successful edit response followed by failed fresh retrieval. This is automated evidence, not live Buffer behavior.

### Controlled media fixture

`tooling/cloudflare-r2-media/` now contains an isolated Worker, deliberate Wrangler configuration template, three project-generated PNG test cards, tests, and setup/cost documentation. The Worker exposes only `/original`, `/replacement`, and `/control`; uses a private `TEST_MEDIA` R2 binding; accepts only GET/HEAD; emits no-store/CDN-no-store headers; performs no logging, analytics, upload, deletion, authentication, redirect, or Cache API operation; validates JPEG/PNG metadata; and returns explicit 410 only when the original object is absent.

The fixture has not been provisioned or deployed. Its private bucket, dedicated `workers.dev` hostname, explicitly disabled Worker cache, object metadata, public HTTPS behavior, and real 200-to-410 transition remain external runtime gates. The Worker also emits no-store headers as defense in depth. Cloudflare's published free allowances appear sufficient for three small test objects and a short run, but R2 requires a separately activated subscription and payment method, and usage beyond the Standard-class allowances can be charged. No zero-cost guarantee is made.

### Controlled post lifecycle

`src/controlled-test-post.ts` and `scripts/controlled-buffer-post.ts` provide a local operator-only method using Gabel's existing encrypted OAuth connection. There is no browser route or unrestricted delete endpoint.

Creation is fixed to one disposable X image post, a unique run marker, automatic custom scheduling at least 72 hours ahead, no tags/draft/approval mode, a freshly validated JPEG/PNG original, exact creation confirmation, and fresh `updatePost` plus `deletePost` capability. Cleanup requires a signed receipt binding the exact tenant, connection, channel, post ID, due time, text, and original URL; a fresh exact match; current `deletePost`; and the exact deletion phrase. Neither uncertain mutation is automatically retried.

The full operator and recovery procedure is in `docs/CONTROLLED-BUFFER-POST-LIFECYCLE.md`. Cleanup remains separately authorized and is confirmed only by API absence plus independent Buffer-dashboard absence. The tooling explicitly does not guarantee cleanup.

### Current decision

The post-status, reviewed lifecycle, and local fixture-code blockers are **RESOLVED LOCALLY / VERIFIED AUTOMATED**. The cleanup procedure and ownership requirements are **DOCUMENTED**, but no cleanup operator has been designated.

**CONDITIONAL GO for the next setup stage only:** after separate authorization, an operator may provision the isolated host, validate all three paths, and prepare the exact disposable-post specification. **NO-GO for creating the post or starting the live repair** until the host passes two-environment checks, a reliable cleanup operator and dashboard recovery path are confirmed, the hard deadline is recorded, and creation receives its own explicit authorization. Production compliance remains **FAILED**.

## M. No-billing Workers replacement (2026-11-04)

This section is the current hosting procedure and supersedes the operational R2 selection in K.2, K.5 steps 7–9, K.7's R2-deletion evidence item, K.8 items 1, 3, and 7, K.9 item 1, and the R2 fixture description in L. The older text is intentionally retained as historical research and must not be followed for this test.

### M.1 Feasibility verdict and evidence

**VERIFIED OFFICIAL DOCUMENTATION:** Cloudflare's current documentation says Workers Free is the default Workers plan; bundled static-asset requests are free and unlimited; bundled asset storage has no additional cost; a public `workers.dev` route does not require onboarding a custom domain; and `assets.run_worker_first` can require Worker execution before any matching asset is served. Cloudflare's Workers product page states that Workers can be started without a credit card.

**VERIFIED AUTOMATED / LOCAL BUILD:** `tooling/cloudflare-workers-media/` uses only the bundled `ASSETS` binding and contains two explicit builds. `ORIGINAL_AVAILABLE` serves the three unchanged project PNGs. `ORIGINAL_REVOKED` returns 410 for `/original` without calling the asset binding and continues serving the exact replacement/control bytes. Tests cover PNG signatures and dimensions, exact bodies, GET/HEAD, MIME and no-store headers, 404/405 responses, absent public state-changing routes, absent R2/KV bindings, and Worker-first configuration. Wrangler dry-run builds recognize exactly three assets and only the `ASSETS` binding.

**VERDICT:** the no-billing design is feasible within documented Workers Free limits and requires no R2, KV, paid Workers plan, custom domain, paid API, external storage subscription, or payment method. This is not a guarantee about a future account screen or changed service terms. If Cloudflare requests billing or a payment method for any required step, hosting is **NO-GO** and the operator must stop.

### M.2 Current route and state contract

The same future `workers.dev` hostname has exactly these states:

| Route | `ORIGINAL_AVAILABLE` | `ORIGINAL_REVOKED` |
|---|---|---|
| `/original` | exact `original.png`, 200 | 410 Gone; no original asset read |
| `/replacement` | exact `replacement.png`, 200 | exact `replacement.png`, 200 |
| `/control` | exact `control.png`, 200 | exact `control.png`, 200 |

Only GET and HEAD are supported. Every other path, including `/original.png`, `/admin`, `/toggle`, `/revoke`, and any query-bearing route, is 404. Unsupported methods are 405. There is no public state control. The only permitted transition is a separately reviewed and authorized deployment of `wrangler.revoked.jsonc`; it must be a normal 100% deployment, not a gradual traffic split.

### M.3 Cache-safety model

Both configurations set `assets.run_worker_first: true`. This routes every request through the Worker before bundled asset handling and prevents raw bundled paths from bypassing the route contract. In the revoked entrypoint, the original route returns 410 before `env.ASSETS.fetch()` runs. Both configurations also set `cache.enabled: false`; every response sends browser/CDN no-store directives.

The 410 guarantee does not rely solely on response headers. It relies on the active revoked Worker executing first and refusing the original. Cloudflare documents that disabling Worker cache does not purge entries created earlier, so the reviewed configurations must never be deployed with caching enabled. A Worker deployment creates a version containing code and bundled assets, and normal deployment targets 100% of traffic.

**UNVERIFIED LIVE:** worldwide deployment propagation, public `workers.dev` TLS/HTTP behavior, and cross-network absence of a stale 200 have not been observed. Local tests cannot prove them. After each separately authorized deployment, Gabel and a second independent public network must agree on the state before the Buffer workflow continues.

### M.4 Revised controlled sequence

Replace the old object-upload/deletion steps with these deployment steps:

1. Keep the Cloudflare account on Workers Free. Do not enable R2, KV, Workers Paid, a custom domain, or another billable service. Stop if billing or a payment method is requested.
2. Run the locked typecheck, unit, integration, Wrangler dry-run, and local-runtime checks for both configurations.
3. Obtain separate authorization for the first external deployment. Deploy `wrangler.available.jsonc` to the dedicated public `workers.dev` hostname.
4. From Gabel and a second independent public network, require HTTPS with no redirects and exact 200 PNG results for original, replacement, and control. Record only sanitized URL identities and response evidence.
5. Create the disposable Buffer post only after its own authorization and the remaining cleanup prerequisites in this runbook are satisfied.
6. When controlled revocation is required, obtain a new authorization for the revoked deployment. Deploy `wrangler.revoked.jsonc` at 100% to the same Worker name/hostname. Do not delete an object, change DNS/TLS, or use a request toggle.
7. From both networks, require `/original` to return 410 with no PNG bytes while replacement/control remain exact 200 PNGs. Any old 200, disagreement, 429, redirect, TLS/network uncertainty, or content mismatch stops the repair.
8. Any rollback, later available deployment, Worker removal, or account cleanup is a separate external mutation and requires its own authorization.

The exact future commands and preflight checks are documented in `tooling/cloudflare-workers-media/README.md`. They were not executed in this local task.

### M.5 Remaining live gates and decision

The following remain **UNVERIFIED LIVE**: the future account's Free-plan/billing state; Wrangler authentication; assigned public hostname; public HTTPS and TLS; no redirects; exact deployed bytes and headers; two-network consistency; real 200-to-410 propagation; free-tier quota behavior; and Gabel's public bounded probe against the deployed routes.

**GO for a future, separately authorized first deployment only**, provided the account remains Workers Free without requesting billing and the reviewed source/configuration still matches. **NO-GO for the revoked deployment until a separate revocation authorization. NO-GO for disposable-post creation or the controlled repair** until the available state passes two-network validation, cleanup ownership and dashboard recovery are confirmed, the hard deadline is recorded, and each Buffer mutation is separately authorized.

Production compliance remains **FAILED**. No Cloudflare resource was provisioned, authenticated, uploaded, or deployed by this local implementation.

## N. Second controlled run: real Detect -> Repair -> Verify

This section prepares the second lifecycle using the existing Worker, original/replacement/control fixtures, Buffer connection, receipt-bound create/delete tool, and Gabel edit implementation. It adds no fixture, endpoint, mutation tool, or duplicate workflow. Preparation is documentation and read-only evidence only.

### N.1 Current readiness evidence — 2026-11-05

- **LIVE READ-ONLY:** Buffer returned one scheduled post, the unchanged November 10 control post; the deleted first-run marker count was zero.
- **LIVE READ-ONLY:** original, replacement, and control each remained HTTP 200 PNG, with matching declared/detected format, expected sizes and 1672 x 941 dimensions, and zero redirects.
- **LOCAL READ-ONLY:** zero active pending edit intents existed.
- **VERIFIED AUTOMATED:** typecheck passed, unit tests passed 61/61, and integration tests passed 3/3.
- **NOT EXECUTED:** no second post/specification, receipt, revocation, edit intent, `editPost`, deletion, deployment, or billing change exists.

### N.2 Timing and stop budget

Use a unique run ID such as `gabel-repair-live-<UTC-date>-01`. Choose `dueAt` at least seven days after creation, exceeding the tool's 72-hour floor. The absolute cleanup cutoff remains `dueAt - 24 hours`.

Reserve one uninterrupted 120-minute operator window. Record its exact UTC start and expiry in the bounded availability attestation. Target this sequence:

- minutes 0-20: final preflight, separately authorized creation, receipt save, and fresh creation verification;
- minutes 20-40: separately authorized revoked deployment and two-network 410/200/200 verification;
- minutes 40-60: genuine Gabel detection, replacement validation, and approval-preview preparation;
- minutes 60-80: separately authorized exact `editPost` and fresh preservation verification;
- minutes 80-105: separately authorized receipt-bound deletion plus API and dashboard absence;
- minutes 105-120: contingency only.

Do not deploy `ORIGINAL_REVOKED` unless at least 80 minutes remain in the attested window. Do not execute `editPost` unless at least 45 minutes remain. Begin cleanup no later than minute 90 regardless of repair outcome. The operational cleanup target is creation plus two hours; missing it is a failed operational target even if the later absolute cutoff is met.

### N.3 Ordered execution plan and authorization gates

1. **Fresh preflight — read-only:** verify the account/channel/schema, exactly one existing November 10 post, zero new-run markers, no pending intent, original/replacement/control at 200/200/200 from Gabel and an independent network, Worker identity/configuration, test suites, dashboard deletion access, exact UTC budgets, and a valid bounded availability attestation.
2. **Creation authorization:** present the exact run ID, fixed caption, channel, due time, original media identity, scheduling modes, and receipt path. Obtain authorization for one `createPost` only.
3. **Create and verify:** use the existing controlled lifecycle tool once. Reopen the signed receipt; freshly verify exact identity, caption, channel, status, due time, modes, sole original PNG, marker uniqueness, update/delete capabilities, and unchanged November 10 post. Never retry an ambiguous creation.
4. **Revocation authorization:** after creation verification and time-budget recheck, request authorization only for deploying the reviewed `wrangler.revoked.jsonc` to the existing Worker. Creation approval does not authorize this.
5. **Real failure state:** deploy once only after authorization. Require original 410 with no PNG bytes and replacement/control exact 200 PNG from Gabel plus an independent public network. Any stale 200, disagreement, redirect, TLS/network uncertainty, wrong bytes, or partial deployment stops repair preparation and moves to cleanup.
6. **Detect:** run Gabel's bounded media check against the receipt-bound post. Require the original to classify as a confirmed unavailable response and the replacement to classify READY. Preserve sanitized evidence; do not infer failure from DNS/TLS/timeout uncertainty.
7. **Prepare and authorize edit:** through the existing Gabel application and matching tenant session, prepare position 0 -> replacement only. Review the sanitized before-state and complete intended asset list. Then obtain separate authorization for the displayed exact `EDIT POST <receipt-bound post id>` mutation. Intent preparation itself must occur only within the agreed live test stage and creates no Buffer mutation.
8. **Edit once and verify:** execute `editPost` once. Never retry an ambiguous mutation. Require fresh Buffer retrieval showing the replacement as the sole ordered PNG and the same identity, caption, channel, scheduled status, due time, share/scheduling modes, tags, and unrelated metadata. Record mismatch or refetch uncertainty as ambiguous, not success.
9. **Deletion authorization:** regardless of repair success, request separate authorization for the signed-receipt post only. If repair failed or became ambiguous, prioritize cleanup immediately.
10. **Cleanup verification:** run receipt-bound deletion once; require direct `NOT_FOUND`, scheduled discovery absence, zero marker matches, and unchanged November 10 state. Separately require the operator's Buffer dashboard confirmation. API and dashboard evidence must remain separately labeled.

Any optional later Worker restoration or removal is outside this ten-step proof and requires its own authorization.

### N.4 Remaining technical gates

- The live edit path must run through a browser session whose tenant owns the existing Buffer connection. This tenant/session mapping must be verified read-only before creating the second post.
- The local server requires truthful `OPERATOR_NAME`, `SUPPORT_EMAIL`, and `PRIVACY_EMAIL`; the repository does not contain those deployment/operator values. They must be configured without exposing them in reports.
- The independent public-network 410/200/200 check and dashboard cleanup check require the operator during the bounded window.
- `editPost` and its fresh preservation comparison remain implemented and automated but untested live. No success may be assumed.
- Production compliance remains **FAILED** and is unaffected by this controlled-test preparation.

**NEXT MUTATION GATE:** after the fresh preflight and a valid bounded availability attestation, present the exact second-post specification and obtain separate user authorization for one `createPost`. Nothing in this plan supplies that authorization.

## O. Final controlled live repair plan â€” 2026-11-07

Current readiness is **FAIL / BLOCKED BEFORE MUTATION**. The restricted runtime attempted a required access-token refresh but was denied before an HTTP response with `EACCES`. Because Buffer refresh tokens rotate and are single-use, Gabel durably classified the started refresh as ambiguous, disabled automatic replay, and marked the connection `reauthorization_required`. Approved-runtime Buffer connectivity independently returned HTTP 400 JSON for a credential-free invalid grant, proving DNS/TLS/endpoint reachability without retrying the stored refresh token. Fresh account/channel discovery, November 10 preservation, and prior-disposable absence therefore remain blocked until a new interactive OAuth grant is completed.

### O.1 Exact proposed identity and scheduled payload

- Run ID: `gabel-repair-live-20261118-01`.
- Caption: `DISPOSABLE GABEL CONTROLLED REPAIR TEST â€” DO NOT PUBLISH [gabel-repair-live-20261118-01]`.
- Destination: the freshly reauthorized, tenant-owned `cocoshalom_` X channel only; its live identity and capabilities must be reverified before creation.
- Publication: `2026-11-18T14:00:00.000Z`, `customScheduled`, `automatic`, scheduled status, no draft/approval mode, and no tags.
- Asset list at creation: exactly one image, the controlled `/original` PNG, with alt text `Disposable Gabel controlled repair test image`.
- Operational cleanup: begin no later than minute 90 of a future accepted 120-minute run window. Absolute cleanup cutoff: `2026-11-17T14:00:00.000Z`. If creation would occur with less than 72 hours of lead, this identity/time plan expires and must be replaced rather than silently changed.
- Creation confirmation, if and only if later requested after a fresh PASS: `CREATE CONTROLLED TEST POST gabel-repair-live-20261118-01`.

Local filename/marker checks show this run ID is new. Buffer-wide uniqueness is **UNKNOWN** until fresh authenticated discovery succeeds, so creation remains blocked.

### O.2 Exact controlled media

| Role | Public path | SHA-256 | Bytes | Dimensions |
|---|---|---|---:|---:|
| Original | `/original` | `9664bc6433b0a8798d87d9dc39195df667beb6a934605cc6904bcfec9b67696d` | 1,239,021 | 1672 Ã— 941 |
| Replacement | `/replacement` | `19fe9f63e6b4d5aba6d97864639ce9922574d3d8e433c62c483abc5ae01c59d5` | 1,263,803 | 1672 Ã— 941 |
| Availability control | `/control` | `90d6ce1889dbc950bc5197ab4eb2f9d136040640c9567827cd25eae371cc76f5` | 1,220,953 | 1672 Ã— 941 |

At `2026-11-07T12:36:13.097Z`, Gabel and an exact-byte read received unredirected public-address HTTP 200 `image/png` for all three paths with matching signatures, sizes, dimensions, local bytes/digests, and `no-store`. Cloudflare's control plane reported the known available-state version `c80c40d9-91c4-4f9e-a1fd-8a87d213aebe` as the newest deployment at 100% traffic. No deployment occurred.

### O.3 Future failure, detection, approval, verification, and cleanup

1. After OAuth recovery, rerun read-only discovery and require: stored/live account match; exactly the intended connected X channel; the protected November 10 post freshly unchanged; every prior disposable receipt identity and marker absent; zero pending edit intents/claims; schema version 3; and current 200/200/200 fixture evidence.
2. Only after a just-in-time preflight and one bounded operator-availability attestation, request separate authorization for the exact `createPost` above. Send one creation attempt and never retry ambiguity. Save and freshly verify the signed receipt; recheck the November 10 post immediately.
3. Request separate authorization for one deployment of the reviewed `ORIGINAL_REVOKED` configuration. Require the exact original to become unredirected HTTP 410 with no PNG bytes while replacement/control remain exact HTTP 200 PNGs, through Gabel and an independent network. Any disagreement stops repair and moves to separately authorized cleanup/restoration.
4. Freshly retrieve the receipt-bound Buffer post. Expected DETECT evidence is asset position 0 bound to `/original`, Gabel `CONFIRMED PROBLEM` from deterministic HTTP 410, and `/replacement` independently `READY` as the exact reviewed PNG. Prior direct checks cannot substitute for this post-bound detection.
5. Obtain separate authorization to prepare the short-lived edit intent. Review the complete one-image asset list, original/replacement fingerprints, verified replacement facts, exact affected position, intent expiry, and protected-field checklist. Intent preparation is not edit authorization.
6. Request the exact one-time confirmation `EDIT POST <fresh disposable post id>`. The durable claim permits only one concurrent request. Immediately refetch the post, require an unchanged fingerprint and `updatePost`, revalidate the replacement, then send one assets-only `editPost` attempt. Never automatically replay a timeout, network error, partial response, or other ambiguous outcome.
7. Freshly refetch and compare: post identity; `scheduled` status; channel ID; caption/text; `dueAt`; `shareMode`; `schedulingType`; common metadata projection; tags; media count; complete media order; and the reconstructed asset list with the replacement at position 0. The single-image controlled post has no unaffected media position; verification must explicitly record that as not applicable and prove no extra/missing/reordered asset. Buffer-managed `updatedAt`, generated asset IDs, request IDs, and changing capability lists are recorded where available but are not falsely claimed invariant.
8. Classify success only if every protected comparison matches. A missing/failed after-read or any discrepancy is `ambiguous`/`REVIEW REQUIRED`, not success.
9. Request separate authorization for one signed-receipt deletion. Require direct `NOT_FOUND`, scheduled-discovery absence, zero marker matches, unchanged November 10 evidence, and operator dashboard absence. Then request separate authorization for one available-state Worker restoration and require exact 200/200/200 bytes plus 100% control-plane state.

No post, media state, edit intent, Buffer mutation, or Cloudflare deployment was created by this preparation.
