# Accessibility test results

Test date: 2026-11-02; addendum reconciliation updated the evidence on the same date. Target: applicable WCAG 2.2 AA criteria. These results are technical checks, not a certification.

| Check | Result | Evidence/limit |
|---|---|---|
| Language, skip link, navigation/main landmarks | PASS (automated source/render test) | Page shell assertions |
| Form labels and native keyboard controls | PASS (automated source test) | All current production inputs have associated or wrapping labels; no positive tabindex or click-only div controls |
| Visible keyboard focus | PASS (automated CSS inspection) | `:focus-visible` rule present with at least 3:1 tested focus color contrast |
| Text/interface contrast | PASS for tested palette | Calculated ratios meet 4.5:1 normal text and 3:1 focus indicator thresholds |
| Table semantics | PASS (source inspection) | Captions and scoped column headers used |
| Image alternatives | NOT APPLICABLE in current UI | No `<img>` elements or decorative image assets |
| Keyboard-only end-to-end use | NOT TESTED manually | Required before production |
| Screen reader names/announcements | NOT TESTED manually | Status/error regions and semantics inspected, but assistive-technology testing is required |
| 200%/400% zoom and reflow | NOT TESTED manually | Required before production |
| Browser/OS high contrast and reduced motion | NOT TESTED manually | No animation is present; platform testing still required |
| Error recovery, focus order after navigation, and confirmation workflow | NOT TESTED manually | Requires a human to exercise validation errors, OAuth return, media results, account controls, and edit review |
| Pointer/touch target sizing and mobile interaction | NOT TESTED manually | Requires browser/device interaction; source inspection alone is insufficient |

Automated checks do not replace manual accessibility testing. No manual row above is marked PASS.

## 2026-11-07 production-readiness addendum

- **PASS — automated/local Chromium:** the bounded browser harness rendered the real server output for authentication/empty state, dashboard, post detail, approval, verified fixture, uncertain fixture, and failed fixture at 1440 by 900 and 500 by 844. It exercised expired session, stale evidence, invalid replacement URL, failed retrieval, and all five media states. Every simulated repair state remained visibly labeled as a local fixture.
- **PASS — automated structure and styling:** labels, native controls, skip navigation, landmarks, visible focus, 44px primary controls, responsive rules, reduced motion, tested 4.5:1 text contrast, and a forced-colors rule for boundaries and focus were verified. A missing forced-colors treatment found in this pass was implemented.
- **FIXED — automation reliability:** browser subprocesses now have a 20-second per-command timeout. The restricted GPU run timed out and was recorded as failed; the approved local headless-Chrome run passed.
- **NOT TESTED manually:** keyboard-only traversal, screen-reader announcements, Windows forced-colors rendering, 200%/400% browser zoom, orientation, and touch-device use still require a human assistive-technology pass before submission. No WCAG conformance certification is claimed.
