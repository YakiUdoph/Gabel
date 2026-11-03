# Gabel product requirements

Created: 2026-11-02 for the Buffer Commit 2026 integration-verification phase. This file records current requirements; it did not guide work performed before its creation.

## Mission

Gabel helps a user identify inaccessible media attached to upcoming Buffer posts and safely repair an affected post while keeping the user in control.

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
