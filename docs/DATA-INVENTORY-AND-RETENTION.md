# Data inventory and retention schedule

| Data | Purpose | Storage/protection | Retention/deletion |
|---|---|---|---|
| Random tenant ID | Separate browser-owned accounts | SQLite | Until account deletion or the tenant has no unexpired browser session; sessionless tenants are purged with all dependent records |
| Session ID and CSRF secret | Authentication and request integrity | Only SHA-256 hashes in SQLite; signed cookie values in browser | Sliding seven days from activity; expired rows are purged, then sessionless tenant deletion cascades; cookies expire on explicit deletion |
| OAuth state, PKCE verifier, and optional reconnect connection/token-version context | Secure Buffer callback and identity-bound reauthorization | State hash; AES-256-GCM verifier; tenant/session-bound SQLite reconnect row containing no token | Ten minutes and one-time consumption; a newer flow replaces it; session, connection, or account deletion cascades |
| Buffer account ID | Associate authorization | SQLite, tenant scoped | Until disconnect or account deletion |
| Buffer tokens | Authorized Buffer API calls | AES-256-GCM ciphertext; never sent to browser/evidence | Until disconnect, account deletion, replacement through refresh rotation, or automatic deletion of a tenant with no unexpired session |
| Granted scopes/token expiry/status | Permission and refresh handling | SQLite | Until disconnect/account deletion |
| Token-refresh claim owner/version/state/timestamps | Serialize single-use refresh across processes sharing SQLite and prevent stale credential writes | SQLite, connection-scoped; contains no token value | One current row per connection; replaced by the next token version; disconnect/account deletion cascades |
| Organization/channel IDs and names, service/state | Display authorized Buffer resources | SQLite, tenant/connection scoped | Up to 24 hours from sync; replaced on sync; disconnect/account deletion deletes |
| Scheduled post ID, channel ID, status, due time, scheduling modes, remote update time, media count | List scheduled posts without retaining content | SQLite, tenant/connection scoped | Up to 24 hours from sync; replaced on sync; disconnect/account deletion deletes |
| Post text and media URLs in sync cache | Not needed | Not retained; legacy rows minimized at startup | Removed immediately by startup minimization/new sync |
| Media-check URL and DNS/network response | User-requested accessibility check | Process memory only; URL is not displayed or written to evidence/cache | Discarded when the request completes; URL-free counts may remain in evidence for up to 30 days |
| Full fresh post and complete intended asset list | Review, stale-write prevention, lossless edit, verification | Tenant-scoped edit intent | Ten minutes; expired intents purged; disconnect/account deletion cascades |
| Edit-intent claim ID/state/timestamps | Durable single-use approval and mutation fencing | SQLite, tenant/intent scoped; contains no post content or media URL | Cascades when the ten-minute edit intent is purged, disconnected, or deleted |
| Evidence event, request ID, counts, outcome, hashed identifiers | Truthful feasibility/security evidence | Tenant-scoped SQLite; secrets sanitized | Up to 30 days; account deletion cascades |
| Operator name/support/privacy emails | Public contact | Environment configuration and rendered pages | Until operator changes configuration |
| Application/security logs | Operational troubleshooting | Console only in current code; Buffer diagnostics sanitized | Deployment operator must define log collection and retention before production |

The current application has no uploaded files, payment data, analytics identifiers, marketing lists, advertising profiles, or application-created social content. SQLite backups, replicas, and infrastructure logs are outside this repository; production retention/deletion procedures for them require an operator decision and verification.
