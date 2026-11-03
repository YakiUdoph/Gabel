# Media-check connectivity diagnosis

Audit date: 2026-11-02 (Atlantic/Cape Verde). This report contains only sanitized host labels, error categories, counts, and timings. No signed URL, media URL from Buffer, credential, identifier, or post content is included.

## A. Root cause

**CONFIRMED:** the historical generic connection-failure path contained a DNS-pinning callback compatibility defect. Current Node HTTPS asks a custom lookup callback for all addresses. The callback must return an array of `{ address, family }` records in that mode; returning the scalar callback shape causes `ERR_INVALID_IP_ADDRESS` before an HTTPS connection or TLS verification occurs. The smallest safe correction is `returnPinnedLookup()`, which returns the required array only when `options.all` is set and continues to pin exactly one previously validated public address.

Live reproduction confirms that Node requests the all-address callback shape for every tested destination. With the corrected callback, three independent public HTTPS image endpoints all pass through Gabel's pinned requester. This establishes that Gabel's current checker is not generally unable to make HTTPS image requests.

**Current Buffer asset result:** a fresh sanitized read-only check at `2026-11-02T21:39:02.041Z` failed during DNS resolution and was classified `dns`. No connection, TLS handshake, HTTP response, or media-format check was possible. This does not establish that the image bytes are broken.

The second historical candidate URL was intentionally not retained and therefore cannot be individually retested. Its prior generic symptom is consistent with the confirmed pinning-callback defect, but its individual remote-host state remains **UNKNOWN**.

## B. Network connectivity results

The restricted execution attempt resolved all three image hosts but blocked both direct and pinned outbound sockets with sanitized `EACCES` results in 3–72 ms. That is **LIVE environment-policy evidence**, not a media or Gabel failure. The approved outbound retry produced:

| Sanitized endpoint | Direct HTTPS | Gabel pinned HTTPS | Redirects |
|---|---:|---:|---:|
| W3C PNG | HTTP 206, 1,203 ms | HTTP 206, 1,104 ms | 1 |
| HTTPBin JPEG | HTTP 200, 1,587 ms | HTTP 200, 1,043 ms | 0 |
| Placeholder PNG | HTTP 206, 588 ms | HTTP 206, 494 ms | 0 |

Evidence classification: **LIVE**. The Gabel path requested a single byte and destroyed the response after headers. It did not download the media body.

## C. DNS results

All three public-image controls resolved in 1–55 ms to two or three IPv4 answers, all classified public. The unsupported-format and TLS controls also resolved to public IPv4 destinations. The current Buffer media hostname failed DNS resolution and produced the sanitized category `dns`; its hostname and URL were not printed.

No live public IPv6 answer was returned by the selected controls. IPv6 policy evidence is therefore **VERIFIED AUTOMATED**, not live: loopback, unspecified, ULA, link-local, multicast, documentation, and IPv4-mapped private forms are rejected.

## D. TLS results

TLS certificate verification succeeded for the three image controls in both direct and pinned HTTPS. A public expired-certificate control failed in both paths as `CERT_HAS_EXPIRED`; Gabel returned the sanitized category `tls` and reason `Media host TLS verification failed` in 711 ms. Evidence classification: **LIVE**.

## E. SSRF policy results

The correction does not disable or bypass SSRF controls. Gabel still requires HTTPS on port 443, rejects URL credentials and local hostnames, validates every resolved address, rejects any mixed public/prohibited answer set, pins one validated address, re-resolves and revalidates every redirect, and caps redirects, time, and headers.

Evidence classification: **VERIFIED AUTOMATED** for private/reserved IPv4, IPv6 edge cases, mixed answers, encoded IPv4, private redirects, redirect limits, and same-host DNS rebinding. The W3C live control additionally completed one public redirect through revalidation.

## F. Media-format results

The three successful image controls returned `image/png` or `image/jpeg` and classified as `image`. A reachable HTTPS HTML control returned HTTP 206 and `text/html; charset=utf-8`; it classified as `unsupported`. This proves that a successful network request is distinct from a supported media format. The current Buffer asset's declared type is JPEG, but its response content type could not be checked because DNS failed.

Evidence classification: **LIVE** for image and unsupported controls; **VERIFIED AUTOMATED** for image, video, PDF, unsupported, and missing content-type classification.

## G. Fixes implemented

- Return the Node-required lookup array shape when the HTTPS client requests `all: true`, while retaining single-address pinning.
- Preserve hostname-based SNI and certificate verification while connecting to the pinned address.
- Emit URL-free categories for DNS, network, TLS, timeout, pinning-callback, and other failures, plus bounded elapsed time.
- Add a sanitized connectivity diagnostic comparing DNS, ordinary HTTPS, Gabel HTTPS, pinning behavior, TLS failure, and content-type classification.
- Include the sanitized media error category in the read-only Buffer verifier.

No SSRF rule, redirect rule, timeout bound, TLS verification, or private-address restriction was weakened.

## H. Regression tests

Pre-change baseline on 2026-11-02: `npm.cmd run typecheck` PASS; `npm.cmd test` PASS 33/33; `npm.cmd run integration` PASS 3/3.

Automated coverage includes the callback array shape, DNS failures, timeouts, TLS failures, unsupported media types, private/reserved IPv4, IPv6 prohibited forms, redirect blocking and limits, same-host DNS rebinding, mixed DNS answers, URL-free errors, and bounded timing. Final post-change command results are recorded in `PROGRESS.md`.

## I. Remaining blockers

- The current Buffer media hostname does not resolve from the approved execution environment. Remote DNS state or an expired/removed host name must be corrected by its owner; Gabel must not bypass DNS or accept it automatically.
- The second historical candidate URL is unavailable by design and cannot be retested individually.
- Production egress policy and live IPv6 connectivity remain infrastructure checks.
- Existing manual accessibility, legal, operator-contact, key-management, backup/logging, and other compliance blockers remain unchanged.

No Buffer edit was prepared or executed. No deployment or phase advancement occurred.

## J. Decision

**GO** for the corrected media checker to continue controlled, read-only validation of public HTTPS candidates. **NO-GO** for the current Buffer asset as a validated reachable replacement because DNS fails. **NO-GO** for production: the production compliance gate remains **FAILED**.
