# Working instructions for Gabel

Created: 2026-11-02 because no project `AGENTS.md` existed. These instructions apply to future work in this repository and do not describe prior agent behavior.

Read `PRD.md`, `ARCHITECTURE.md`, `DESIGN.md`, `RULES.md`, `TASKS.md`, `PROGRESS.md`, the compliance-gate documents, and the current phase report before changing Gabel.

Preserve the existing architecture unless a verified defect requires a scoped correction. Keep credentials server-side and encrypted, scope every user-owned record by tenant, preserve explicit mutation approval and fresh before/after verification, and never weaken deletion, retention, SSRF, security-header, or accessibility safeguards.

Use official Buffer documentation for API claims. Label evidence as live, automated, implemented-but-untested, documented-only, blocked, failed, or unknown. Mocked tests are never live evidence. Never place secrets or signed private media URLs in output, source, fixtures, logs, or documentation.

Run the existing tests before and after code changes. Record missing commands as missing rather than claiming success. Update `TASKS.md` and append to `PROGRESS.md`; do not rewrite prior progress entries. Stop for interactive OAuth, creation of a real test post, or approval of a live edit. Do not deploy or advance phases automatically.
