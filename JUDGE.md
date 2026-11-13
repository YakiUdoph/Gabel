# Judge guide

## Start here

Gabel finds an upcoming Buffer API post whose externally hosted image may no longer open. It can validate a replacement and, only after an exact human confirmation, change that image while checking that the post's copy, channel, schedule, and other assets remain intact.

**Current decision: public app ready for read-only evaluation.** Open [https://gabel-six.vercel.app](https://gabel-six.vercel.app). It runs on Vercel Functions with durable Neon PostgreSQL. There is no seeded judge account or demo credential. One controlled disposable-post repair was verified live on November 8, 2026, but that post was deleted during authorized cleanup, so use a Buffer account and scheduled post you control and stop after the read-only media check unless a disposable edit is separately authorized.

The public product page is `/`; the genuine Buffer workflow begins at `/workspace`. The product preview on the landing page is explicitly illustrative and contains no account or outcome data.

## 1. What Gabel solves

Buffer's API accepts media through public URLs and may fetch the media hours or days after a post is scheduled. A URL that worked during scheduling can expire, be removed, or become inaccessible before publication. Gabel connects the media dependency to its scheduled Buffer post so the user can check it and prepare a controlled replacement.

Gabel is not a general broken-link checker. Its value is the Buffer context and repair guardrails around a scheduled post.

## 2. Who it is for

The current target user is a developer, technical creator, or small operations team that schedules image posts through Buffer's API, MCP server, CLI, or another automation and hosts the media outside Buffer.

This target is an evidence-supported hypothesis, not a validated customer segment. Gabel has no customer interviews, adoption metrics, or paid-user evidence yet.

## 3. Why Buffer is essential

Buffer supplies the authenticated organizations, channels, scheduled posts, media assets, post status, and update capability. Gabel uses Buffer again to prepare the asset-only edit and to fetch the post before and after mutation. A URL checker alone cannot identify the affected Buffer post or verify that its schedule and copy survived the repair.

## 4. Core workflow

1. The user connects Buffer through OAuth with PKCE.
2. Gabel retrieves genuine channels and scheduled posts.
3. The user asks Gabel to check a post's media.
4. Gabel makes a bounded, public-HTTPS-only request and labels each checked asset without showing its URL.
5. For a supported scheduled X image post, the user may provide a stable public JPEG or PNG replacement.
6. **Prepare only** validates the replacement and shows the sanitized before-state and complete intended asset list. No mutation has occurred.
7. The user types `EDIT POST <post-id>` to authorize that exact edit.
8. Gabel fetches the post and replacement again. If either changed or the intent expired, it stops.
9. Gabel sends only the post ID and complete asset list, then fetches the post again and compares protected fields.
10. Gabel reports verified success only when the fresh comparison matches; uncertain outcomes remain ambiguous.

## 5. What to test first

Test **Check media accessibility** first. It performs fresh Buffer and media reads but does not edit the post. Confirm that:

- the page shows genuine connected channels and scheduled posts;
- no seeded or demo post appears;
- media results do not display source URLs; and
- uncertain network results say **COULD NOT VERIFY**, not “broken.”

Do not proceed to confirmation unless the post is explicitly disposable and you are authorized to change it.

## 6. Exact prerequisites

### Hosted route

Use [https://gabel-six.vercel.app](https://gabel-six.vercel.app). Bring an authorized Buffer account and scheduled media post. There is no shared test account or disposable scheduled post.

### Local route

- Node.js 24 or newer.
- Dependencies installed with `npm.cmd ci` on Windows PowerShell (`npm ci` elsewhere).
- A registered Buffer OAuth app client.
- An exact HTTPS callback, normally `https://localhost:3443/auth/buffer/callback`, registered with Buffer.
- A locally trusted TLS certificate and private key.
- A private `.env` based on `.env.example`, including truthful operator contacts and two separate random 32-byte keys.
- A Buffer account you control, a connected channel, and a scheduled post with externally hosted media.
- For repair only: a disposable scheduled X image post, a direct public HTTPS JPEG or PNG replacement no larger than 5 MB or 8192 by 8192 pixels, and explicit approval of the final reviewed change.

Do not send credentials, tokens, private post text, or signed media URLs to a judge or place them in repository files.

## 7. Short walkthrough

The complete happy path below describes implemented behavior. All steps were completed once in a controlled live run on November 8, 2026, with separate mutation approvals, fresh verification, receipt-bound cleanup, and media-fixture restoration. There is no currently available hosted setup for a judge to repeat that run.

1. Open the hosted URL above, or start the local app with `npm.cmd start`.
2. Select **Connect Buffer**, approve the requested access, then select **Refresh from Buffer**.
3. On a scheduled media post, select **Check media accessibility** and inspect the label.
4. Stop here for a read-only judge test.
5. On a disposable scheduled X image post with a fresh confirmed failure only, enter a real stable JPEG/PNG URL that you control, then select **Validate image and review change**.
6. Confirm that the review says no mutation has been sent. Inspect the confirmed original response, validated replacement properties, protected fields, and technical fingerprints.
7. If and only if the exact change is authorized, type the displayed `EDIT POST <post-id>` phrase and submit once.
8. Read the fresh comparison. A matching comparison should say **Edit verified**; a mismatch or uncertain mutation should not be presented as success.

There is currently no authorized disposable setup for steps 5–8. Repeating the controlled proof requires a new disposable post, bounded operator window, controlled media state, and each separate authorization in [docs/CONTROLLED-E2E-REPAIR-TEST-PLAN.md](docs/CONTROLLED-E2E-REPAIR-TEST-PLAN.md).

## 8. Important failure cases

| Case | Expected behavior |
|---|---|
| Media returns 404/410 | **CONFIRMED PROBLEM** with the HTTP status; no edit occurs. |
| DNS, TLS, timeout, or other inconclusive network failure | **COULD NOT VERIFY**; Gabel does not call the media broken. |
| Private, local, unsafe, or non-HTTPS destination | The safety check refuses the request or replacement. |
| MIME type and file signature disagree | **UNSUPPORTED FILE** or replacement rejection. |
| Replacement is not JPEG/PNG, is too large, has invalid dimensions, or targets a non-X channel | No edit intent is created. |
| Post changes after the review | Confirmation stops before mutation. |
| Replacement evidence expires or the file changes | Confirmation stops before mutation. |
| Confirmation phrase is wrong | No mutation is sent. |
| Network outcome is uncertain during mutation | Gabel reports ambiguity and does not retry automatically. Inspect Buffer directly. |
| Fresh after-read differs from the intended/protected state | The result is not reported as verified success. |

## 9. Expected outcomes

- **CONFIRMED PROBLEM:** the remote server gave a confirmed unsuccessful HTTP response.
- **COULD NOT VERIFY:** the check was inconclusive or blocked by safety policy.
- **UNSUPPORTED FILE:** the server responded, but the media checks did not support the file.
- **READY:** the bounded checks passed at that moment; this is not a publication guarantee.
- **Edit verified:** Buffer's fresh after-state matched the intended assets and protected fields.
- **Edit outcome is ambiguous:** Gabel could not safely prove the final state.

## 10. Real evidence

- [Buffer live integration report](docs/BUFFER-LIVE-INTEGRATION-REPORT.md) — live and automated evidence ledger, including later successful scheduled-post discovery.
- [Media-check connectivity report](docs/MEDIA-CHECK-CONNECTIVITY-REPORT.md) — live network, TLS, format, and sanitized Buffer-asset findings.
- [Controlled repair plan](docs/CONTROLLED-E2E-REPAIR-TEST-PLAN.md) — unexecuted setup, approvals, proof requirements, and cleanup.
- [Competitive validation and Serial Winner Score](docs/COMPETITIVE-VALIDATION-AND-SERIAL-WINNER-SCORE.md) — target user, alternatives, 64/100 score, and failed judgeability gates.
- [Compliance gate](docs/COMPLIANCE-PRIVACY-SECURITY-ACCESSIBILITY-GATE.md) — production status and unresolved controls.
- [Accessibility results](docs/ACCESSIBILITY-TEST-RESULTS.md) — automated checks and manual tests still required.

## 11. Known limitations

- Hosted on Vercel with durable Neon PostgreSQL; fresh interactive production OAuth still requires the account owner.
- One successful live Gabel repair and fresh preservation proof exists, but no disposable judge post is currently available to reproduce the mutation.
- Current repair validation supports JPEG and PNG images on scheduled X posts only.
- A media check inspects at most ten assets per request and at most a 64 KiB prefix of each response. It cannot prove whole-file integrity or future availability.
- The browser application does not create or delete Buffer posts. The local receipt-bound controlled-test lifecycle tool was executed during controlled live runs; it is not a general application endpoint.
- There is no background monitoring, automatic repair, bulk edit, or automatic mutation retry.
- Vercel production coordinates refresh-token and edit claims transactionally in PostgreSQL; local/Docker SQLite remains a single-host rollback path.
- Manual accessibility testing, qualified legal review, truthful production contacts, licensing, and infrastructure review remain unresolved.
- User demand, failure frequency, and willingness to pay are unknown.

## 12. Current verification status

| Status | Evidence |
|---|---|
| Verified live | OAuth-backed Buffer reads for account, organization, channel, scheduled post, image asset, update capability, and schema/media format; bounded media requests; and one controlled assets-only `editPost` with fresh zero-discrepancy preservation verification, separate cleanup, and fixture restoration. |
| Verified by automated tests | 80 unit/security tests and 5 integration tests cover security, isolation, media policy, replacement validation, approval, stale state, field preservation, verified repaired-state cleanup, controlled lifecycle and no-billing media-fixture safeguards, deletion, inactivity retention, and structural accessibility. |
| Verified in production | Public landing/workspace/readiness routes, security headers, managed database persistence, and OAuth initiation with exact callback and S256 PKCE. |
| Implemented but not currently reproducible | The controlled live repair evidence exists, but there is no disposable post or shared judge account. |
| Blocked | Fresh interactive production OAuth, controlled disposable repair, manual accessibility review, legal review, and final competition submission. |

## 13. Cleanup and safety

For read-only testing, no Buffer content cleanup is needed.

After local evaluation:

1. Open **Account** in Gabel.
2. Type `DISCONNECT BUFFER` and submit to delete local encrypted credentials and cached Buffer connection data.
3. In Buffer settings, revoke Gabel if you also want Buffer to invalidate the OAuth grant.
4. Type `DELETE GABEL DATA` only if you want to delete the browser tenant, sessions, edit intents, evidence, and remaining local records. This does not delete Buffer posts.
5. If a separately authorized disposable post was ever created, clean it up manually in Buffer under a separate authorization. Gabel has no create/delete route.
6. Remove local `.env`, database, and certificate files according to your own development-environment policy. They are ignored by Git and must never be committed.

Production compliance remains **FAILED** because manual accessibility and qualified legal review are outstanding. The public app is available for read-only judging; do not treat deployment as a compliance certification.

## 14. Buffer Commit submission package (prepared, not submitted)

Official requirements verified on November 13, 2026: a public app, a demo video no longer than two minutes showing the live Buffer API flow, an approximately 300-word summary, team identity/contact details, the Buffer client ID, and optional build-in-public links. The app must remain public through judging. The deadline is November 13 at 11:59 PM Pacific. Sources: [Buffer Commit](https://buffer.com/api/commit) and [official terms](https://buffer.com/api/commit/terms).

### Draft summary (approximately 300 words)

Gabel helps people who schedule image posts through Buffer catch a fragile dependency before it becomes a failed publication. Scheduled posts can reference externally hosted media. A link that worked when the post was created may expire, be removed, or become inaccessible before Buffer needs it. Gabel turns that gap into a focused recovery workflow: DETECT, REPAIR, VERIFY.

After the user authorizes Buffer with OAuth and PKCE, Gabel retrieves genuine organizations, channels, and scheduled posts. The user chooses a post and runs a fresh, bounded media check. Results stay deliberately honest: a confirmed unsuccessful response is a CONFIRMED PROBLEM; network or safety uncertainty is COULD NOT VERIFY; an unsupported response is UNSUPPORTED FILE; and a passing check is READY only at its recorded time.

For a supported scheduled X image post, Gabel can validate a direct public JPEG or PNG replacement. It shows the exact affected position, replacement properties, protected fields, and sanitized evidence before anything changes. The user must type a post-specific confirmation phrase. Immediately before the edit, Gabel refetches the Buffer post and revalidates the replacement. It sends one assets-only `editPost` operation, never automatically retries an uncertain mutation, then refetches the post and compares its text, destination, schedule, status, metadata, tags, untouched media, and order. Success is recorded only when the fresh after-state matches.

The current implementation uses Buffer OAuth, account/organization/channel and scheduled-post reads, schema/media-format reads, `editPost`, and fresh post retrieval. A controlled disposable post completed the full live workflow with zero protected-field discrepancies; it was subsequently deleted under separate approval.

Next steps are a reliable public judge deployment, hands-on accessibility review, qualified legal review, and broader channel/media support after the narrow X image path is proven.

### Two-minute demo script

1. **0:00–0:12 — Problem:** show the landing page and explain the externally hosted media failure window.
2. **0:12–0:28 — Connect:** open `/workspace`, complete Buffer OAuth, and refresh genuine scheduled posts.
3. **0:28–0:48 — Detect:** open a disposable scheduled post, run the fresh media check, and show CONFIRMED PROBLEM evidence.
4. **0:48–1:12 — Review:** enter the stable replacement, show validation, the exact before/after position, and protected fields. State clearly that no edit has occurred.
5. **1:12–1:31 — Approve:** type the post-specific phrase and send the single approved repair.
6. **1:31–1:48 — Verify:** show the fresh Buffer refetch and zero-discrepancy protected-field comparison.
7. **1:48–2:00 — Close:** show the post in Buffer, state the current narrow scope, and name the next step.

### Still required before submission

- [ ] Reliable public URL that survives the judging window.
- [ ] Interactive production OAuth and genuine scheduled-post smoke test.
- [ ] Fresh disposable post plus explicit approval for the live demo mutation and cleanup.
- [ ] Recorded video at or below two minutes.
- [ ] Verified legal names, emails, social handles, team captain, and Buffer client ID entered in the submission form.
- [ ] Manual accessibility and qualified legal review tracked as unresolved if they cannot be completed before submission.
