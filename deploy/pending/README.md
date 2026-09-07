# Bible subdomain rollout gate

`bible.starsnap.kr` is intentionally not part of the active Caddyfile yet.
Apply `bible.Caddyfile` only after all of the following are approved:

1. Create the public Cloudflare DNS record for `bible.starsnap.kr` without an
   unsupported AAAA record.
2. Confirm TCP 80/443 still reach the Caddy gateway for ACME validation.
3. Build and verify immutable shared SNS web/API image digests, but do not
   replace the running API before its schema is ready.
4. Add only `https://bible.starsnap.kr` to the production
   `CORS_ORIGIN_PATTERNS` value. Verify an allowed preflight and a normal
   authenticated meditation mutation; the shared Nginx proxy preserves the
   public `Origin` header when it calls the backend.
5. Apply the fail-loud V11 schema migration while licensed verse tables remain
   empty, then deploy the verified SNS web/API digests.
6. Add the Caddy block, then add internal and public Bible verification in the
   same approved release. Verification must assert the upstream DOM marker
   `[data-app-surface="bible"]` in an authenticated browser, not only the shared
   HTML title or Caddy-injected surface header. Also assert the effective CSP,
   `X-Frame-Options`, `X-Content-Type-Options`, referrer policy, surface header,
   API health, and representative scanner-probe blocks.
7. Keep `BIBLE_LICENSE_GRANTED=false` until the written licence, translation
   allowlist, expiry date, approved data source, and DB translation row are all
   in place.
8. Validate the licensed import inventory before enabling it: every canonical
   book must have one stable `book_order`, and each translation/book/chapter/
   verse key must be unique with zero missing or duplicate rows.

DNS/TLS readiness never authorises publishing protected Bible text.
