# PocketChest Deployment Guide

This guide walks you through deploying PocketChest, a secure file-sharing application that runs as a single Cloudflare Worker.

## Architecture Overview

- **One Worker** serves the API (`/api/*`) and the static frontend (built by Vite into `dist/` and uploaded as Workers Static Assets)
- **R2** stores everything: file content and a small JSON manifest per chest (no database)
- **Cron trigger** (hourly) deletes expired chests and abandoned uploads
- **Authentication**: One owner, with three independent sign-in methods: password, authenticator app (TOTP) and passkey

There is no separate Cloudflare Pages project and no separate API domain.

## Prerequisites

- [Cloudflare account](https://cloudflare.com/) (free tier works)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) installed globally

```bash
npm install
npx wrangler login
```

All commands below run from the repository root.

## Deployment

### 1. Create the R2 Bucket

```bash
npx wrangler r2 bucket create pocket-chest
```

If you used a different bucket name, update the bucket name in `wrangler.jsonc`. Otherwise, no configuration changes are needed.

```jsonc
{
  "r2_buckets": [
    {
      "bucket_name": "pocket-chest", // The name you used in the `wrangler r2 bucket create` command
      "binding": "R2_STORAGE" // Just use `R2_STORAGE` regardless of bucket_name
    }
  ]
}
```

### 2. Configure Custom Domain (Optional)

**Using Routes in wrangler.jsonc**

If you have a domain managed by Cloudflare, you can configure a custom domain route directly in your `wrangler.jsonc`:

```jsonc
{
  "routes": [
    {
      "pattern": "share.yourdomain.com",
      "custom_domain": true
    }
  ],
  "workers_dev": false  // Optional: disable default *.workers.dev domain
}
```

**Workers.dev Domain Control:**
- By default, your Worker will be accessible at both your custom domain AND `your-worker-name.your-subdomain.workers.dev`
- To disable the default workers.dev domain, set `"workers_dev": false` in your `wrangler.jsonc`
- When `workers_dev` is false, your Worker will ONLY be accessible via your custom domain routes. This is recommended for production deployments where you want to use only your custom domain
- **⚠️ China Access**: The default `*.workers.dev` domain is not accessible from China. If you need China accessibility, you must use a custom domain

**Requirements:**
- Your domain must be added to Cloudflare (as a zone)
- **Do NOT configure DNS records beforehand** - Cloudflare will handle this automatically during deployment
- **Important**: Use a subdomain (3-level domain like `share.yourdomain.com`) for automatic SSL certificates
- Avoid deeper subdomains (4+ levels like `share.pc.yourdomain.com`) as they won't receive automatic SSL certificates due to Cloudflare limitations

### 3. Configure Secrets and Variables

**⚠️ IMPORTANT**: Never put secrets in the `wrangler.jsonc` vars section; use Cloudflare Worker Secrets ([docs](https://developers.cloudflare.com/workers/configuration/secrets/)).

| Name | Kind | Purpose |
|------|------|---------|
| `JWT_SECRET` | Secret | Signs upload and download tokens. Changing it ends all tokens. |
| `AUTH_ENCRYPTION_KEY` | Secret | 32-byte AES key, base64, that seals the authenticator seed. Lose it and the authenticator must be set up again. |
| `ADMIN_BOOTSTRAP_PASSWORD` | Secret | Used once, to create the owner (at least 16 characters). Remove it after setup. |
| `BOOTSTRAP_ENABLED` | Variable | `"true"` only while the first setup is pending; `"false"` otherwise (`wrangler.jsonc`). |
| `PASSKEY_RP_ID` | Variable | Optional. The one hostname passkeys are bound to; see Passkey Domain. |

Generate the random values with:

```bash
openssl rand -base64 48    # JWT_SECRET
openssl rand -base64 32    # AUTH_ENCRYPTION_KEY (must decode to exactly 32 bytes)
openssl rand -base64 24    # ADMIN_BOOTSTRAP_PASSWORD
```

```bash
npx wrangler secret put JWT_SECRET
npx wrangler secret put AUTH_ENCRYPTION_KEY
npx wrangler secret put ADMIN_BOOTSTRAP_PASSWORD
```

Set `"BOOTSTRAP_ENABLED": "true"` in `wrangler.jsonc` for the first deployment only.

### 4. Deploy

```bash
npm run deploy
```

This builds the frontend into `dist/` and deploys the Worker together with the static assets. The cleanup cron job is configured in `wrangler.jsonc` and deploys automatically.

PocketChest will be available at `https://pocket-chest.your-subdomain.workers.dev` (or your custom domain if configured).

## Post-Deployment Configuration

### 1. First-time setup

1. Open `https://<your-domain>/upload/`. While the owner does not exist and bootstrap is enabled, the page asks for the administrator password.
2. Enter `ADMIN_BOOTSTRAP_PASSWORD`. The owner is created with that password, and you are signed in.
3. Set `"BOOTSTRAP_ENABLED": "false"` in `wrangler.jsonc`, deploy again, and remove the secret:
   ```bash
   npx wrangler secret delete ADMIN_BOOTSTRAP_PASSWORD
   ```
   Bootstrap cannot run a second time, even with the secret present, so this step is about hygiene: the secret should not stay on the Worker.

### 2. Set up the other sign-in methods

Sign in, then open **Security settings** on the upload page:

- **Password**: change it there (at least 16 characters). Changing it ends the other sessions.
- **Authenticator app**: *Set up authenticator* shows an `otpauth://` link. Add it to an authenticator app and confirm with a code. A wrong code leaves the current setup unchanged.
- **Passkeys**: *Add passkey* registers the device. A new passkey is not used for sign-in until you switch the passkey method on.

Each change asks you to confirm with a method you hold. A method cannot be switched off if it is the last one that works.

### 3. Test the deployment

1. Sign in on `/upload/` and upload a file.
2. Open the returned link on `/retrieve/`, and download the file.

### 4. Lost access

If every sign-in method is unavailable, follow [docs/RECOVERY.md](docs/RECOVERY.md). It is an offline command run by the deployer; the website has no recovery route.

## Environment Variables Reference

| Name | Kind | Required | Description |
|------|------|----------|-------------|
| `JWT_SECRET` | Secret | Yes | Signs upload and download tokens |
| `AUTH_ENCRYPTION_KEY` | Secret | Yes, once an authenticator is set up | Base64 32-byte key that seals the authenticator seed |
| `ADMIN_BOOTSTRAP_PASSWORD` | Secret | During first setup only | Creates the owner; remove afterwards |
| `BOOTSTRAP_ENABLED` | Variable | Yes | `"true"` only during first setup |
| `PASSKEY_RP_ID` | Variable | Recommended | The one hostname passkeys are bound to |
| `AUTH_LIMITER`, `RETRIEVE_LIMITER`, `UPLOAD_LIMITER`, `PART_LIMITER`, `PART_TOTAL_LIMITER`, `DOWNLOAD_LIMITER` | Rate limiting bindings | Yes | Per-client request limits (`ratelimits` in `wrangler.jsonc`) |

The frontend needs no configuration: it calls the API on the same origin.

For local development, put these values in `.dev.vars` (see `.dev.vars.example`).

## Monitoring and Maintenance

### View Logs
```bash
# Worker logs
npx wrangler tail

# Inspect a chest manifest by retrieval code
npx wrangler r2 object get pocket-chest/codes/ABC123 --pipe --remote
```

### Cleanup Job

The Worker runs `0 * * * *` (hourly, `wrangler.jsonc`). Each run is bounded and the next run continues where it stopped. It:
- Deletes chests whose expiry has passed, together with their files
- Deletes upload sessions that were not completed within 48 hours, and aborts their unfinished multipart uploads
- Finishes or rolls back uploads stuck in finalization for more than an hour
- Removes owner sign-in sessions that have ended, expired challenges, and resets quiet sign-in failure counters (locked counters are never touched)
- Removes stored file objects that no session refers to, after a 48-hour grace period

Expiry is also enforced on every request, so an expired chest is unreachable even before the job removes it.

### Operating the Cron Job

```bash
# Follow the Worker's logs while the next run happens (or trigger one, see below)
npx wrangler tail --format pretty

# Local check of the scheduled handler, with the same entry point the platform calls
npx wrangler dev --test-scheduled
curl "http://localhost:8787/__scheduled?cron=0+*+*+*+*"
```

A run logs a `Cleanup summary` with counts. A run that finishes with errors logs `Cleanup finished with N error(s)` and is reported as failed; the remaining work is retried by the next run. Check after the first day that the counts are stable and the error line does not repeat.

### Watching the Storage

- `npx wrangler r2 bucket info pocket-chest` shows the stored size; compare it with what the uploads imply
- Object key types, for orientation:

| Key | Content |
|-----|---------|
| `{sessionId}/{fileId}` | File content |
| `codes/{CODE}` | Chest manifest (JSON): session, expiry and file list |
| `expiry/{expiresAt}/{CODE}` | Empty marker; lets the cleanup job find due chests in time order |
| `pending/{createdAt}/{sessionId}` | Empty marker for an upload that has not been completed yet |
| `auth/owner.json` | Owner record: password hash, sealed authenticator seed, passkey public keys |
| `auth/sessions/{sha256(sid)}` | Owner sign-in sessions (the cookie value itself is never stored) |
| `auth/challenges/{sha256(challenge)}` | One-time passkey and authenticator-enrolment challenges |
| `auth/throttle/{method}.json` | Sign-in failure counters for password and authenticator |
| `auth/bootstrap-marker` | Records that first-time setup was claimed |
| `maintenance/orphan-cursor.json` | Where the orphan scan continues |

### Passkey Domain

Set `PASSKEY_RP_ID` to the one hostname the site is served on, for example `pocket.example.com`:

```jsonc
// wrangler.jsonc, "vars"
"PASSKEY_RP_ID": "pocket.example.com"
```

Passkeys are bound to that hostname. With the variable set, any request on another hostname (for example the `workers.dev` address next to a custom domain) is refused with `PASSKEY_DOMAIN_MISMATCH`. Set it before the first passkey is registered: a passkey made for one hostname does not work on another.

## Security Considerations

1. **JWT Secret**: Use a strong, unique secret for production
2. **Sign-in methods**: Keep at least two sign-in methods set up, so one lost device does not lock you out
3. **File Types**: The system accepts all file types - consider validation if needed
4. **Rate Limiting**: Consider adding rate limiting for production use
5. **Same origin**: The API sends no CORS headers, so other sites cannot call it from a browser

## Troubleshooting

### Common Issues

1. **Blank page or 404 for `/upload/`**: Make sure `npm run deploy` (not plain `wrangler deploy`) ran, so `dist/` was built
2. **Storage Errors**: Ensure the R2 bucket exists and `bucket_name` in `wrangler.jsonc` matches it
3. **Authenticator Issues**: Check that the device clock is synchronized; codes are time-based

### Debug Commands

```bash
# Test backend endpoints
curl https://your-worker.workers.dev/api/chest -X POST
```

## Scaling Considerations

- **R2**: First 10GB storage free, then $0.015/GB/month; 1M Class A and 10M Class B operations/month free (a chest uses a handful of each)
- **Workers**: 100,000 requests/day free, then $0.50 per million; static asset requests are free and do not invoke the Worker

For higher usage, consider Cloudflare's paid tiers.
## Known limits (review v3, FIX-12)

- **Workers plan**: password hashing uses PBKDF2 with 600,000 iterations. Node measures about 150 ms of wall time for it, which is not billed CPU time on Workers. Cloudflare lists 10 ms of CPU for the Free plan, so do not assume the Free plan works. Measure sign-in CPU on a real Worker (TASK-31, R11) before choosing a plan.
- **Rate limits** are counted per Cloudflare location, so they are approximate across the world. The owner-level lockout in `auth/throttle.ts` is the real protection for sign-in. Its check, verify and record steps are separate requests, so a burst of simultaneous guesses can all be verified before the lock takes effect. Add a Cloudflare WAF rate-limiting rule on `/api/auth/*` if that matters for your deployment.
- **Content-Security-Policy** is served as report-only (`public/_headers`). Watch the browser console on your own domain, then switch the header name to `Content-Security-Policy` once nothing is reported.
- **Downloads** do not support `Range` requests, so an interrupted large download starts again from the beginning.
- **Cleanup** scans owner sessions and passkey challenges in batches of 500 and remembers its position. A `⚠️ Cleanup backlog remains` line in the Worker logs on every run means the job cannot keep up.
