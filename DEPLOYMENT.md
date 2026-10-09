# PocketChest Deployment Guide

This guide walks you through deploying PocketChest, a secure file-sharing application that runs as a single Cloudflare Worker.

## Architecture Overview

- **One Worker** serves the API (`/api/*`) and the static frontend (built by Vite into `dist/` and uploaded as Workers Static Assets)
- **R2** stores everything: file content and a small JSON manifest per chest (no database)
- **Cron trigger** (hourly) deletes expired chests and abandoned uploads
- **Authentication**: Optional TOTP (Time-based One-Time Password)

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

### 3. Configure Secrets

**⚠️ IMPORTANT**: Never put secrets in `wrangler.jsonc` vars section - use Cloudflare Worker Secrets ([docs](https://developers.cloudflare.com/workers/configuration/secrets/)) instead.

#### Generate Secrets

Use the provided script to generate secure secrets:

```bash
# Generate JWT + single TOTP user
node scripts/generate-secrets.js [key-name]

# Generate JWT + multiple TOTP users
node scripts/generate-secrets.js admin user1 user2 user3

# Generate only TOTP keys (for adding users later)
node scripts/generate-secrets.js --totp-only newuser1 newuser2
```

**Script Features:**
- **JWT_SECRET**: Secure random key for token signing. You should use a randomly generated JWT secret for security.
- **Multiple TOTP Users**: Generate multiple users at once with setup instructions
- **Add Users Later**: Use `--totp-only` flag to generate additional TOTP keys

**Multiple Users Supported**: The TOTP system supports unlimited users with different TOTP secrets. Format: `key1:secret1,key2:secret2,key3:secret3`. Any user with a valid TOTP token can access the system.

#### Configure Secrets and Variables
**1. Configure TOTP Setting in `wrangler.jsonc`:**

```jsonc
{
  "vars": {
    "REQUIRE_TOTP": "true"    // Set to "false" to disable TOTP
  }
}
```

**2. Set Cloudflare Worker Secrets:**

```bash
# Set JWT secret (REQUIRED)
npx wrangler secret put JWT_SECRET
# Paste the JWT secret from the generator when prompted

# Set TOTP secrets (ONLY if REQUIRE_TOTP is "true")
npx wrangler secret put TOTP_SECRETS
# Paste the TOTP secrets from the generator when prompted
```

**Note**: If prompted "Do you want to create a new Worker with that name and add secrets to it?", choose **Y** (yes).


**3. Add TOTP Keys to Your Authenticator App:**

The script will output setup URLs and secret keys for each generated TOTP user. Add these to your preferred authenticator app like 1Password or Google Authenticator:

**Example: Adding to 1Password:**

Create a *One-Time Password* field, then enter the output string (like `otpauth://totp/PocketChest%3Axxxx?secret=xxxxxxxxxxxxxxxxxxx&issuer=PocketChest&algorithm=SHA1&digits=6&period=30`) into that field.
Fill in your PocketChest domain to enable autofill.
![1Password-TOTP](assets/1Password-TOTP.png)


**💡 Use Case Guide:**
- **Private/Team Use**: Enable TOTP (`"REQUIRE_TOTP": "true"`) for secure access with known users
- **Public Use**: Disable TOTP (`"REQUIRE_TOTP": "false"`) to allow anyone to share files
- **TOTP setup appears complex because it's designed for private deployments with controlled access**

**Security Notes:**
- Secrets are encrypted and stored securely by Cloudflare
- Never commit secrets to version control
- You should generate and use unique secrets
- Remove any secrets from the `wrangler.jsonc` vars section

### 4. Deploy

```bash
npm run deploy
```

This builds the frontend into `dist/` and deploys the Worker together with the static assets. The cleanup cron job is configured in `wrangler.jsonc` and deploys automatically.

PocketChest will be available at `https://pocket-chest.your-subdomain.workers.dev` (or your custom domain if configured).

## Post-Deployment Configuration

### 1. Test Deployment

1. Visit your PocketChest URL
2. Try uploading files (with TOTP if enabled)
3. Test retrieval with the generated code
4. Verify files download correctly

### 2. Adding TOTP Keys Later

⚠️ **Important**: Cloudflare Worker secrets are encrypted and hidden - you cannot view existing secret values. When adding new users, you have two options:

**Option 1: Replace All Keys (Recommended)**
1. Generate new keys for ALL users (existing + new):
   ```bash
   node scripts/generate-secrets.js --totp-only admin user1 user2 newuser
   ```
2. Update all users' authenticator apps with the new secrets
3. Set the new combined secret:
   ```bash
   npx wrangler secret put TOTP_SECRETS
   # Enter the complete new secret string when prompted
   ```

**Option 2: Keep Existing Keys (More Complex)**
1. **Before deployment**: Save your TOTP secrets in a secure location (password manager)
2. When adding users: Generate only new keys and manually combine with saved existing keys
3. This requires you to have recorded the original secrets

**Recommended Approach**: Use Option 1 and regenerate all keys when adding users. This ensures you have a complete record of all active keys and maintains security.

## Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `JWT_SECRET` | Yes | Long random string for JWT signing (secret) |
| `REQUIRE_TOTP` | Yes | Set to "true" to enable TOTP auth (`vars` in `wrangler.jsonc`) |
| `TOTP_SECRETS` | If TOTP enabled | Comma-separated `name:base32secret` pairs (secret) |

The frontend needs no configuration: it calls the API on the same origin.

For local development, put these values in `.dev.vars` (see `.dev.vars.example`).

**Note**: TOTP configuration is automatically fetched from the backend via `/api/config` endpoint.

## Monitoring and Maintenance

### View Logs
```bash
# Worker logs
npx wrangler tail

# Inspect a chest manifest by retrieval code
npx wrangler r2 object get pocket-chest/codes/ABC123 --pipe --remote
```

### Cleanup Job

The Worker runs a cleanup job every hour. It:
- Deletes chests whose expiry has passed, together with their files
- Deletes upload sessions that were never completed within 48 hours

Expiry is also enforced on every request, so an expired chest is unreachable even before the job removes it. Unfinished multipart uploads are aborted by R2's default bucket lifecycle rule (7 days).

### Storage Layout

Everything lives in the R2 bucket:

| Key | Content |
|-----|---------|
| `{sessionId}/{fileId}` | File content |
| `codes/{CODE}` | Chest manifest (JSON): session, expiry and file list |
| `expiry/{expiresAt}/{CODE}` | Empty marker; lets the cleanup job find due chests in time order |
| `pending/{createdAt}/{sessionId}` | Empty marker for an upload that has not been completed yet |

## Security Considerations

1. **JWT Secret**: Use a strong, unique secret for production
2. **TOTP**: Enable TOTP for sensitive deployments
3. **File Types**: The system accepts all file types - consider validation if needed
4. **Rate Limiting**: Consider adding rate limiting for production use
5. **Same origin**: The API sends no CORS headers, so other sites cannot call it from a browser

## Troubleshooting

### Common Issues

1. **Blank page or 404 for `/upload/`**: Make sure `npm run deploy` (not plain `wrangler deploy`) ran, so `dist/` was built
2. **Storage Errors**: Ensure the R2 bucket exists and `bucket_name` in `wrangler.jsonc` matches it
3. **TOTP Issues**: Verify secrets are properly formatted and time is synchronized

### Debug Commands

```bash
# Test backend endpoints
curl https://your-worker.workers.dev/api/chest -X POST
```

## Scaling Considerations

- **R2**: First 10GB storage free, then $0.015/GB/month; 1M Class A and 10M Class B operations/month free (a chest uses a handful of each)
- **Workers**: 100,000 requests/day free, then $0.50 per million; static asset requests are free and do not invoke the Worker

For higher usage, consider Cloudflare's paid tiers.