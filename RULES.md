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
12. Keep the README's **How to Test Gabel** section and `JUDGE.md` accurate, prominent, and beginner-readable. Separate hosted and local routes, lead with a read-only test, and state when deployment or live repair evidence is missing.
13. Preserve the locked concept: **Gabel — Keep your scheduled posts ready**, a Buffer-native scheduled-media recovery product whose core workflow is **DETECT → REPAIR → VERIFY**.
14. Do not implement a feature unless it directly contributes to the locked workflow, competition obligations, security, usability, or release readiness. Do not add unrelated AI features, dashboards, analytics, or speculative scope.
15. Follow the locked execution order: controlled live repair, fresh preservation proof, product UI, differentiation evidence, then competition/release completion. Do not use later priorities to bypass an unresolved P0 gate.
