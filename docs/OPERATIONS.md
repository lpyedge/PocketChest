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

## Before an upgrade

An upgrade must keep your installation's Worker, bucket and settings. Before deploying new code over an existing installation, compare the configuration it runs with the one about to be deployed. This reads local files only; it never calls Cloudflare and never touches R2:

```bash
node scripts/deploy-preflight.mjs --current path/to/installed-wrangler.jsonc --candidate wrangler.jsonc
# optional: --current-secrets JWT_SECRET,ADMIN_BOOTSTRAP_PASSWORD --candidate-secrets JWT_SECRET,ADMIN_BOOTSTRAP_PASSWORD
```

It refuses (exit 1, reasons on stderr, no secret values) when the Worker name, an R2 bucket behind a binding, the routes, `workers_dev`, `PASSKEY_RP_ID` would change, when `BOOTSTRAP_ENABLED` would go from off back to `"true"`, or when an expected secret name disappears. Changes to code, assets or compatibility date pass.

## Update from upstream

The Deploy Button copies this repository into your account; it does not keep it in sync. The **Update from upstream** workflow (`.github/workflows/upstream-update.yml`, started by hand from the Actions tab, or weekly) brings the official code (`master` of `lpyedge/PocketChest`) into your copy as a **pull request** for you to review:

- It merges upstream into a new branch and opens the pull request. It does not merge it, does not deploy, and has no Cloudflare or secret access. After you merge, your normal deploy upgrades the code only (`npm run deploy` recognises a finished installation and asks for nothing).
- Before it opens anything it checks that the merge keeps your Worker name, bucket, routes and passkey domain. If upstream would change them, or the same lines conflict with your own edits, it stops, changes nothing and says why. Merge upstream by hand in that case.
- Files under `.github/workflows/` are never taken from upstream (a token without the `workflow` permission cannot push them, and they are yours). Changes there are listed and left out.
- The repository must allow Actions to create pull requests (Settings → Actions → General → Workflow permissions). If it does not, the branch is still pushed and you can open the pull request from it.
- Do not press the Deploy Button again to upgrade: use this workflow, or merge upstream yourself.

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
| `revoked/{sessionId}` | Empty marker for a revoked share whose files are not removed yet; cleanup finishes the removal |
| `maintenance/instance-id` | This installation's id for rate limit keys; created once, never rewritten |
| `auth/owner.json` | Owner record: password hash, sealed authenticator seed, passkey public keys |
| `auth/sessions/{sha256(sid)}` | Owner sign-in sessions (the cookie value itself is never stored) |
| `auth/challenges/{sha256(challenge)}` | One-time passkey and authenticator-setup challenges |
| `auth/throttle/{method}.json` | Sign-in failure counters for password and authenticator |
| `auth/bootstrap-marker` | Records that first-time setup was claimed |
| `maintenance/*` | Cursors for the scans that continue across runs |

Never delete `auth/bootstrap-marker` by hand to reopen setup. If setup was interrupted (marker present, no owner), run `node scripts/recover-bootstrap.mjs` as described in [offline recovery](RECOVERY.md).

## Known limits

- **Password storage is cheap on purpose.** The Workers Free plan allows very little CPU per request, so the password is stored as a salted HMAC-SHA256 under a key the Worker derives from `JWT_SECRET` (`HMAC-SHA256-KEYED-V1`), not as a slow hash. A copy of the bucket alone cannot be used to test guesses, and the sign-in lockout limits online guessing; use a long password you use nowhere else. There is no other password format. Do not change `JWT_SECRET` once the owner exists: the password and an authenticator, if one is set up, would stop verifying.
- **Rate limit counters are kept apart per installation.** The limiter namespaces in `wrangler.jsonc` are shared by every Worker in the same Cloudflare account, so each key starts with an id that belongs to this installation: a random id created once in the bucket (`maintenance/instance-id`), the same on `workers.dev` and on a custom domain, and never changed by an upgrade. You do not set anything. To choose it yourself, set a plain variable `INSTANCE_ID`. If the bucket cannot be read, requests are still limited under a shared prefix until it can.
- **Rate limits are approximate.** Cloudflare counts per location. The owner-level lockout is the real protection for sign-in; it reserves a place in the guess budget before each check, so parallel guesses cannot all be checked. A WAF rate-limiting rule on `/api/auth/*` adds another layer.
- **Upload sessions last 24 hours** from the moment they start, for every upload token. Resuming after that is not supported.
- **CSP is report-only** (`public/_headers`). Watch the browser console on your own domain, then rename the header to `Content-Security-Policy` once nothing is reported.
- **Downloads do not support `Range`**, so an interrupted large download starts again.
- **Real Cloudflare checks are still yours to run**: R2 concurrency, Cron, rate limits, passkeys on the final domain, large files. See [REMOTE_ACCEPTANCE.md](REMOTE_ACCEPTANCE.md).
