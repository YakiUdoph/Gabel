# Third-party service, dependency, and asset inventory

Audit date: 2026-11-02.

## Services

| Service | Data/role | SDK | Review note |
|---|---|---|---|
| Buffer OAuth (`auth.buffer.com`) | Authorization codes and token exchange | None; native `fetch` | PKCE/state implemented; tokens encrypted; user revocation is performed in Buffer settings |
| Buffer GraphQL (`api.buffer.com`) | Account/org/channel/scheduled-post reads and explicitly confirmed edit | None; native `fetch` | Tenant scoped; response/error classification; fresh before/after verification |
| Connected social platforms | Buffer may send scheduled content/media to them | None; indirect through Buffer | Gabel cannot guarantee acceptance/publication; platform terms/privacy apply |
| DNS resolver and selected media hosts | Resolve and perform a user-requested bounded accessibility check | Node built-ins | All answers must be public; requests pin a validated address, revalidate redirects, cap redirects/time/headers, and do not download the response body |

No analytics, advertising, email delivery, payment, error-reporting SaaS, CDN, hosted font, or customer-support SDK is present.

## npm dependency and license inventory

There are no runtime npm packages. Installed development packages from `package-lock.json`/`npm ls --all`:

| Package | Version audited | Role | Declared license |
|---|---:|---|---|
| `typescript` | 5.9.3 | Type checker | Apache-2.0 |
| `@types/node` | 24.19.2 | Node type declarations | MIT |
| `undici-types` | 7.24.6 | Transitive Node fetch types | MIT |

`npm.cmd audit --json` returned zero known vulnerabilities on 2026-11-02. Registry audits are point-in-time checks and do not prove absence of vulnerabilities.

## Visual/code assets

The UI uses only CSS and the operating system's `system-ui`/monospace fonts. No third-party images, icons, testimonials, metrics, web fonts, copied UI libraries, or generated visual assets were found. Gabel itself has no repository license file; the operator should choose a project license before distributing the source. This is not a third-party license defect, but it is a release/distribution decision.
