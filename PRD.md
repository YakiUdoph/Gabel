# Gabel product requirements

Created: 2026-11-02 for the Buffer Commit 2026 integration-verification phase. This file records current requirements; it did not guide work performed before its creation.

## Mission

Gabel helps Buffer API and automation users find externally hosted media that becomes unavailable between scheduling and publication. It lets the user review and approve a safe replacement while preserving the rest of the scheduled post.

The current repair path is deliberately narrow: JPEG and PNG image replacements on scheduled X posts. Broader platform or media support is not part of the current product claim.

## Locked product concept

**Gabel — Keep your scheduled posts ready.**

Gabel is a Buffer-native scheduled-media recovery product. Its locked core workflow is **DETECT → REPAIR → VERIFY**. This concept must not be redesigned or diluted with unrelated features.

Work is prioritized in this order:

1. **P0:** complete the separately authorized controlled live repair using a new disposable scheduled post.
2. **P1:** prove from fresh Buffer evidence that only the approved image changed and every protected post field remained unchanged.
3. **P2:** turn the feasibility interface into a premium, intuitive, accessible product UI without weakening approval or verification boundaries.
4. **P3:** verify differentiation against documented Buffer-native capabilities and relevant competitors without unsupported originality claims.
5. **P4:** complete official competition compliance, deployment, documentation, and submission gates without premature readiness claims.

Before implementation, every proposed feature must directly support this workflow, a competition requirement, security, usability, or release readiness. Otherwise it is out of scope.

## Judge reproducibility

`README.md` must keep a prominent **How to Test Gabel** section immediately after the short product introduction. It must provide separate hosted-judge and local-developer routes, state genuine prerequisites, explain the result labels and approval boundary, and identify anything that is not deployed or not verified live.

The repository must also keep `JUDGE.md` as the practical evaluation guide. Neither document may invent a public URL, sandbox, account, disposable post, credential, mutation, or successful repair. A judge must be directed to a read-only first test and must never be asked to change an important scheduled post.

## Current acceptance gate

The phase must establish independently reproducible evidence for secure Buffer authorization, genuine scheduled-post retrieval, supported media discovery, one explicitly approved test edit, fresh post-edit verification, preservation of unrelated content/scheduling, and truthful failure handling. Mocked tests are not live evidence.

## In scope

- Buffer OAuth Authorization Code flow with PKCE and secure token rotation.
- Tenant-scoped retrieval of organizations, channels, and scheduled posts with pagination.
- Inspection of documented media asset fields.
- Safe preparation and explicit approval of one media edit on a user-controlled disposable scheduled post.
- Fresh before/after Buffer reads and comparison.
- Existing compliance, privacy, security, accessibility, deletion, and retention controls.

## Out of scope

- Automatic or bulk post editing.
- Creating or scheduling a test post without explicit approval.
- Claiming successful publication.
- Paid plans, analytics, marketing email, testimonials, fake statistics, or decorative dashboards.
- Advancing to a later phase automatically.

## Success and stop conditions

Success requires authentic live evidence for the core flow. Stop for missing Buffer credentials, interactive OAuth, absence of a user-controlled test post, missing explicit live-edit approval, unsupported schema/capabilities, or a security issue. Never request secrets in chat or fabricate results.
