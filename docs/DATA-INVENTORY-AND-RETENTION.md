# Data inventory and retention schedule

| Data | Purpose | Storage/protection | Retention/deletion |
|---|---|---|---|
| Random tenant ID | Separate browser-owned accounts | SQLite | Until account deletion; tenant row may remain empty if cookies are lost, pending operator cleanup policy |
| Session ID and CSRF secret | Authentication and request integrity | Only SHA-256 hashes in SQLite; signed cookie values in browser | Seven days; expired rows purged; account deletion cascades; cookies expired on deletion |
| OAuth state and PKCE verifier | Secure Buffer callback | State hash; AES-256-GCM verifier | Ten minutes and one-time consumption; session expiry/account deletion also removes it |
| Buffer account ID | Associate authorization | SQLite, tenant scoped | Until disconnect or account deletion |
| Buffer tokens | Authorized Buffer API calls | AES-256-GCM ciphertext; never sent to browser/evidence | Until disconnect, account deletion, or replacement through refresh rotation |
| Granted scopes/token expiry/status | Permission and refresh handling | SQLite | Until disconnect/account deletion |
| Organization/channel IDs and names, service/state | Display authorized Buffer resources | SQLite, tenant/connection scoped | Up to 24 hours from sync; replaced on sync; disconnect/account deletion deletes |
| Scheduled post ID, channel ID, status, due time, scheduling modes, remote update time, media count | List scheduled posts without retaining content | SQLite, tenant/connection scoped | Up to 24 hours from sync; replaced on sync; disconnect/account deletion deletes |
| Post text and media URLs in sync cache | Not needed | Not retained; legacy rows minimized at startup | Removed immediately by startup minimization/new sync |
| Media-check URL and DNS/network response | User-requested accessibility check | Process memory only; URL is not displayed or written to evidence/cache | Discarded when the request completes; URL-free counts may remain in evidence for up to 30 days |
| Full fresh post and complete intended asset list | Review, stale-write prevention, lossless edit, verification | Tenant-scoped edit intent | Ten minutes; expired intents purged; disconnect/account deletion cascades |
| Evidence event, request ID, counts, outcome, hashed identifiers | Truthful feasibility/security evidence | Tenant-scoped SQLite; secrets sanitized | Up to 30 days; account deletion cascades |
| Operator name/support/privacy emails | Public contact | Environment configuration and rendered pages | Until operator changes configuration |
| Application/security logs | Operational troubleshooting | Console only in current code; Buffer diagnostics sanitized | Deployment operator must define log collection and retention before production |

The current application has no uploaded files, payment data, analytics identifiers, marketing lists, advertising profiles, or application-created social content. SQLite backups, replicas, and infrastructure logs are outside this repository; production retention/deletion procedures for them require an operator decision and verification.
