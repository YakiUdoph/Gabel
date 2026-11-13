# Judge guide

## Start here

Gabel finds an upcoming Buffer API post whose externally hosted image may no longer open. It can validate a replacement and, only after an exact human confirmation, change that image while checking that the post's copy, channel, schedule, and other assets remain intact.

**Current decision: not judge-ready.** Gabel is not deployed and has no judge sandbox or demo credentials. One controlled disposable-post repair was verified live on November 8, 2026, but that post was deleted during the authorized cleanup, so the safest current evaluation remains a local read-only media check against a Buffer account and scheduled post you control.

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

Blocked. There is no public application URL, judge sandbox, test account, or disposable scheduled post.

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

1. Start the app with `npm.cmd start` and open the configured HTTPS origin.
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

- Not deployed; no hosted judge route exists.
- One successful live Gabel repair and fresh preservation proof exists, but no public judge can currently reproduce it.
- Current repair validation supports JPEG and PNG images on scheduled X posts only.
- A media check inspects at most ten assets per request and at most a 64 KiB prefix of each response. It cannot prove whole-file integrity or future availability.
- The browser application does not create or delete Buffer posts. The local receipt-bound controlled-test lifecycle tool was executed during controlled live runs; it is not a general application endpoint.
- There is no background monitoring, automatic repair, bulk edit, or automatic mutation retry.
- Production requires single-process operation until refresh-token coordination is made safe across instances.
- Manual accessibility testing, qualified legal review, truthful production contacts, licensing, and infrastructure review remain unresolved.
- User demand, failure frequency, and willingness to pay are unknown.

## 12. Current verification status

| Status | Evidence |
|---|---|
| Verified live | OAuth-backed Buffer reads for account, organization, channel, scheduled post, image asset, update capability, and schema/media format; bounded media requests; and one controlled assets-only `editPost` with fresh zero-discrepancy preservation verification, separate cleanup, and fixture restoration. |
| Verified by automated tests | 80 unit/security tests and 5 integration tests cover security, isolation, media policy, replacement validation, approval, stale state, field preservation, verified repaired-state cleanup, controlled lifecycle and no-billing media-fixture safeguards, deletion, inactivity retention, and structural accessibility. |
| Implemented but not publicly reproducible | The controlled live repair evidence exists, but there is no hosted judge environment, disposable post, or judge account. |
| Blocked | Hosted judge reproduction, controlled disposable repair, production release, and competition-readiness claim. |
| Planned | Public deployment and judge reproduction only after the blocking proof and compliance work are complete. |

## 13. Cleanup and safety

For read-only testing, no Buffer content cleanup is needed.

After local evaluation:

1. Open **Account** in Gabel.
2. Type `DISCONNECT BUFFER` and submit to delete local encrypted credentials and cached Buffer connection data.
3. In Buffer settings, revoke Gabel if you also want Buffer to invalidate the OAuth grant.
4. Type `DELETE GABEL DATA` only if you want to delete the browser tenant, sessions, edit intents, evidence, and remaining local records. This does not delete Buffer posts.
5. If a separately authorized disposable post was ever created, clean it up manually in Buffer under a separate authorization. Gabel has no create/delete route.
6. Remove local `.env`, database, and certificate files according to your own development-environment policy. They are ignored by Git and must never be committed.

Production compliance remains **FAILED**. Do not treat these instructions as proof that Gabel is ready for public judging.
