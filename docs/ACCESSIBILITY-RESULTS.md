# Accessibility test results

Date: 2026-11-02.

Automated Node tests verify the rendered shell has a language, skip link, labeled primary navigation, main landmark, visible `:focus-visible` rules, operator contact, no positive tabindex, and declared foreground/background ratios of at least 4.5:1 for primary text, secondary text, and button text. Production forms use native inputs/buttons, programmatic labels, table captions, scoped headers, semantic sections, and status roles. The source contains no images requiring alternatives.

Automated results do not establish WCAG 2.2 AA conformance and do not replace manual testing.

Manual tests still required before release:

1. Complete every flow using keyboard only, including OAuth return, sync, edit review/confirmation, disconnect, and deletion.
2. Confirm logical focus order, visible focus, zoom/reflow at 200% and 400%, error announcement, and focus placement after navigation/errors.
3. Test with at least one screen reader/browser combination and verify table/form/status announcements.
4. Verify contrast in a rendered browser for all states, including visited links, native form controls, high-contrast mode, and any future branding.
5. Test mobile touch targets and orientation.

Status: automated structural/contrast checks PASS after the final test rerun; manual accessibility and assistive-technology testing NOT TESTED.
