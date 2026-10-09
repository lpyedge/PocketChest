# Operations reference

For installing, see [DEPLOYMENT.md](../DEPLOYMENT.md) ([繁體中文](../DEPLOYMENT.zh-Hant.md) · [日本語](../DEPLOYMENT.ja.md)). This page is for running an installation.

## Custom domain

If your domain is managed by Cloudflare, add a route in `wrangler.jsonc`:

```jsonc
{
  "routes": [{ "pattern": "share.example.com", "custom_domain": true }],
  "workers_dev": false // optional: turn off the default *.workers.dev address
}
```

- Do not create DNS records beforehand: Cloudflare creates them when the Worker is deployed.
- Use a three-level hostname such as `share.example.com`. Deeper names do not get an automatic certificate.
- With `workers_dev` off, the Worker answers only on your routes. The default `*.workers.dev` address is not reachable from mainland China, so a custom domain is also the way to be reachable there.

## Passkey domain

Passkeys are bound to one hostname. Set it before the first passkey is registered:

```jsonc
// wrangler.jsonc, "vars"
"PASSKEY_RP_ID": "share.example.com"
```

With the variable set, a request on any other hostname (for example the `workers.dev` address beside a custom domain) is refused with `PASSKEY_DOMAIN_MISMATCH`. A passkey made for one hostname does not work on another.

## Logs and the cleanup job

```bash
npx wrangler tail --format pretty        # follow the Worker's logs
npx wrangler dev --test-scheduled        # run the scheduled handler locally
curl "http://localhost:8787/__scheduled?cron=0+*+*+*+*"
```

The Worker runs `0 * * * *` (hourly). Each run is bounded, and the next run continues where it stopped. It:

- deletes chests whose expiry has passed, with their files;
- takes over and removes upload sessions that were not completed within 48 hours (uploads themselves close after 24 hours), and aborts their unfinished multipart uploads;
- finishes or rolls back uploads stuck in finalization for more than an hour, and removes code claims that no session owns;
- removes owner sessions that have ended and expired challenges, and resets quiet sign-in failure counters (locked counters are never touched);
- removes stored files that no session refers to, after a 48-hour grace period.

A run logs a `Cleanup summary` with counts. A run that finishes with errors logs `Cleanup finished with N error(s)` and is reported as failed; the next run retries the rest. A `⚠️ Cleanup backlog remains` line on every run means the job cannot keep up. Retrieval codes are never written to these logs.

## What is stored

`npx wrangler r2 bucket info pocket-chest` shows the stored size. Key types, for orientation:

| Key | Content |
|-----|---------|
| `{sessionId}/{fileId}` | File content |
| `sessions/{sessionId}` | Upload session record (state, files, uploads, planned expiry) |
| `codes/{CODE}` | Chest manifest (JSON): session, expiry and file list |
| `expiry/{expiresAt}/{CODE}` | Empty marker; lets cleanup find due chests in time order |
| `pending/{createdAt}/{sessionId}` | Empty marker for an upload that has not been completed |
| `finalizing/{startedAt}/{sessionId}` | Empty marker for a completion in progress |
| `auth/owner.json` | Owner record: password hash, sealed authenticator seed, passkey public keys |
| `auth/sessions/{sha256(sid)}` | Owner sign-in sessions (the cookie value itself is never stored) |
| `auth/challenges/{sha256(challenge)}` | One-time passkey and authenticator-setup challenges |
| `auth/throttle/{method}.json` | Sign-in failure counters for password and authenticator |
| `auth/bootstrap-marker` | Records that first-time setup was claimed |
| `maintenance/*` | Cursors for the scans that continue across runs |

Never delete `auth/bootstrap-marker` to reopen setup. If setup was interrupted (marker present, no owner), run `node scripts/recover-bootstrap.mjs` as described in [offline recovery](RECOVERY.md).

## Known limits

- **Workers plan.** Password hashing uses PBKDF2 with 600,000 iterations. Cloudflare lists 10 ms of CPU for the Free plan; do not assume it is enough. Measure sign-in on your real plan, and do not weaken the hash to fit.
- **Rate limits are approximate.** Cloudflare counts per location. The owner-level lockout is the real protection for sign-in; it reserves a place in the guess budget before each check, so parallel guesses cannot all be checked. A WAF rate-limiting rule on `/api/auth/*` adds another layer.
- **Upload sessions last 24 hours** from the moment they start, for every upload token. Resuming after that is not supported.
- **CSP is report-only** (`public/_headers`). Watch the browser console on your own domain, then rename the header to `Content-Security-Policy` once nothing is reported.
- **Downloads do not support `Range`**, so an interrupted large download starts again.
- **Real Cloudflare checks are still yours to run**: R2 concurrency, Cron, rate limits, passkeys on the final domain, large files. See [REMOTE_ACCEPTANCE.md](REMOTE_ACCEPTANCE.md).
