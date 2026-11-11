# No-billing controlled media fixture

Status: implemented and automated locally; not provisioned, uploaded, or deployed.

This fixture uses only Cloudflare Workers Free and bundled static assets. It has no R2, KV, external-storage, custom-domain, payment-method, or paid-plan dependency. The three existing project-generated PNG files remain under `assets/` with their original bytes.

## Public contract

Both builds expose only these unauthenticated paths on one future public `workers.dev` hostname:

| Path | `ORIGINAL_AVAILABLE` | `ORIGINAL_REVOKED` |
|---|---|---|
| `/original` | exact `original.png`, HTTP 200 | HTTP 410 Gone; the asset binding is not read |
| `/replacement` | exact `replacement.png`, HTTP 200 | exact `replacement.png`, HTTP 200 |
| `/control` | exact `control.png`, HTTP 200 | exact `control.png`, HTTP 200 |

Only GET and HEAD are accepted. Unknown paths, raw bundled filenames, queries, and administration-like paths return 404. Other methods return 405 with `Allow: GET, HEAD`. There is no upload, delete, toggle, administration, or state-changing route. All responses are no-store, successful media responses are `image/png`, and the Worker never redirects.

The state is compiled into two entrypoints and two reviewed configurations:

- `worker.available.mjs` plus `wrangler.available.jsonc` is `ORIGINAL_AVAILABLE`.
- `worker.revoked.mjs` plus `wrangler.revoked.jsonc` is `ORIGINAL_REVOKED`.

Changing state requires deploying the other configuration. A request cannot select state through a query, header, body, cookie, or route.

## Why cached assets cannot bypass the revoked Worker

Both configurations set `assets.run_worker_first` to `true`, so Cloudflare must invoke the Worker before serving any matching bundled asset. Raw paths such as `/original.png` are rejected by the Worker. In the revoked build, `/original` returns 410 before `env.ASSETS.fetch()` is called, so a bundled copy cannot satisfy that route.

Both configurations also set `cache.enabled` to `false`, and responses include `Cache-Control: no-store, max-age=0` and `CDN-Cache-Control: no-store`. These headers are defense in depth, not the revocation mechanism. Cloudflare documents that disabling Worker cache does not purge previously cached entries. This fixture therefore must never be deployed with caching enabled, and a future operator must stop if the deployed configuration differs from the reviewed files.

A deployment creates a new Worker version containing its code, assets, bindings, and compatibility settings; a normal `wrangler deploy` sends that version to 100% of traffic. Worker-first routing prevents an asset response from bypassing the active revoked code. However, this repository has not tested worldwide deployment propagation or cache behavior. The 200-to-410 transition remains **UNVERIFIED LIVE** until the separately authorized deployments are checked from at least two independent public networks.

## Local verification

Install exactly the locked development dependencies:

```powershell
npm.cmd ci
```

Run the automated checks from the repository root:

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run integration
```

Run the available build in Wrangler's local Worker runtime:

```powershell
npm.cmd run fixture:dev:available
```

In another terminal, check `http://localhost:8787/original`, `/replacement`, and `/control`, including GET and HEAD. Stop the runtime, then run the revoked build:

```powershell
npm.cmd run fixture:dev:revoked
```

Repeat the checks and require 410 only for `/original`. Local HTTP is runtime evidence only; it does not establish public HTTPS, `workers.dev`, global propagation, or independent-network behavior.

## Future deployment procedure — authorization required

Do not run these steps during local preparation. They intentionally perform external account and deployment changes.

1. Use a Cloudflare account that remains on Workers Free. Do not activate Workers Paid, R2, KV, a custom domain, or any other billable product. If the dashboard or CLI requests a payment method or paid-plan activation, stop.
2. Run `npm.cmd ci`, then rerun typecheck, unit, integration, and both local-runtime checks from the locked source.
3. Authenticate Wrangler interactively to the intended Cloudflare account. This is a stop point for the user/operator; never place credentials or tokens in source, command output, or documentation.
4. Review `wrangler.available.jsonc`, confirm `workers_dev: true`, `preview_urls: false`, `cache.enabled: false`, `assets.binding: "ASSETS"`, and `assets.run_worker_first: true`, and obtain explicit authorization for the first deployment.
5. Deploy the available version from the repository root:

   ```powershell
   npx.cmd wrangler deploy --config tooling/cloudflare-workers-media/wrangler.available.jsonc
   ```

6. Record the assigned `https://gabel-controlled-media.<account-subdomain>.workers.dev` hostname without placing account credentials in project evidence. From Gabel and a second independent public network, verify all three routes: HTTPS, no redirect, 200, PNG MIME/signature, exact byte length and digest, expected dimensions, and no-store headers. Unknown/raw paths must be 404 and unsupported methods 405.
7. Only after the disposable Buffer-post setup and a separate revocation authorization, re-review `wrangler.revoked.jsonc`. Deploy it as a normal 100% deployment, not a gradual or split deployment:

   ```powershell
   npx.cmd wrangler deploy --config tooling/cloudflare-workers-media/wrangler.revoked.jsonc
   ```

8. From the same two independent networks, require `/original` to return 410 with no redirect and no PNG bytes, while `/replacement` and `/control` remain exact 200 PNG responses. Treat disagreement, an old 200, a 429, a redirect, or network/TLS uncertainty as a failed transition; do not begin or continue the Buffer mutation.
9. Any rollback, later available-state deployment, Worker deletion, or account cleanup is a separate external mutation and needs its own authorization.

## Cost and account boundary

Checked against current official Cloudflare material on 2026-11-04:

- Workers Free is the default Workers plan and includes 100,000 Worker requests per day, 10 ms CPU per invocation, 128 MB memory, and 50 subrequests per invocation.
- Static-asset requests are free and unlimited, and Cloudflare states there is no additional cost for storing bundled assets.
- Because this fixture deliberately uses Worker-first routing, its public requests invoke the Worker and count against the Workers Free daily request allowance. If the free allowance is exceeded, Cloudflare documents a 429/error response rather than fallback asset serving.
- Workers Free permits 20,000 static files per version and 25 MiB per file. This fixture has three files of about 1.2 MB each.
- Cloudflare advertises Workers as free to start with no credit card required. A public `workers.dev` route avoids a custom domain.

The local code cannot prove the future account is still on Free or that Cloudflare will never change its terms. Before each deployment, the operator must confirm the account shows no paid Workers subscription or payment-dependent requirement. If any necessary step requires billing, the procedure is **NO-GO**.

Official sources:

- https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/
- https://developers.cloudflare.com/workers/static-assets/binding/
- https://developers.cloudflare.com/workers/static-assets/routing/worker-script/
- https://developers.cloudflare.com/workers/configuration/routing/workers-dev/
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/workers/versions-and-deployments/
- https://developers.cloudflare.com/workers/cache/configuration/
- https://www.cloudflare.com/products/workers/
