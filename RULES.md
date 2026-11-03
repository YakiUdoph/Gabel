# Gabel phase rules

Created: 2026-11-02 from the attached Buffer Commit 2026 phase brief and existing compliance gate. These rules apply from this point forward.

1. Use current official Buffer documentation as the primary schema and behavior reference.
2. Never claim `VERIFIED LIVE` without an authentic successful Buffer operation.
3. Never request or expose access tokens, refresh tokens, client secrets, signed media URLs, or private post content in chat/reports.
4. Never create, schedule, edit, or bulk-edit a Buffer post without the required user authorization. A live edit requires a user-controlled disposable post and explicit approval of the exact intended change.
5. Preserve unrelated assets, post content, scheduling, and channel association; refetch before and after mutation.
6. Treat transport uncertainty, partial GraphQL responses, and failed verification truthfully as failure or ambiguity.
7. Do not weaken SSRF, credential, tenant-isolation, retention, deletion, header, or accessibility controls.
8. Do not treat hostname/string checks alone as complete SSRF protection or use an unrestricted URL fetcher.
9. Do not add fake claims, statistics, testimonials, subscriptions, marketing email, unnecessary dependencies, or unrelated features.
10. Record exact commands/results and distinguish inspection, automated mocks, documented behavior, and live evidence.
11. Do not mark the compliance gate PASS or advance phases automatically.
