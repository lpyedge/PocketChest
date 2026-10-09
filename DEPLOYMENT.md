# PocketChest Deployment Guide

This guide walks you through deploying PocketChest, a secure file-sharing application that runs as a single Cloudflare Worker.

## Architecture Overview

- **One Worker** serves the API (`/api/*`) and the static frontend (built by Vite into `dist/` and uploaded as Workers Static Assets)
- **D1** stores chest metadata, **R2** stores file content
- **Cron trigger** (hourly) deletes expired chests
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

### 1. Create Cloudflare Resources

#### Create D1 Database

```bash
npx wrangler d1 create pocket-chest
```

Save the database ID from the output. Update `wrangler.jsonc`:

```jsonc
{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "pocket-chest",
      "database_id": "<your-database-id-here>"
    }
  ]
}
```

#### Create R2 Bucket

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

### 2. Initialize Database Schema

```bash
npx wrangler d1 execute pocket-chest --file=schema.sql --remote
```

> Tip: to stop git from picking up your real database ID, run `git update-index --assume-unchanged wrangler.jsonc`.

### 3. Configure Custom Domain (Optional)

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

### 4. Configure Secrets

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

### 5. Deploy

```bash
npm run deploy
```

This builds the frontend into `dist/` and deploys the Worker together with the static assets. The cleanup cron job is configured in `wrangler.jsonc` and deploys automatically.

PocketChest will be available at `https://pocket-chest.your-subdomain.workers.dev` (or your custom domain if configured).

> Upgrading from the old two-part deployment (Pages frontend + `pocket-chest-backend` Worker)? The Worker is now named `pocket-chest`, so deploying creates a new Worker. Reuse your existing D1 database ID and R2 bucket, set the secrets again on the new Worker, move your custom domain to it, then delete the old Pages project and old Worker.

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

# Check D1 database
npx wrangler d1 execute pocket-chest --command "SELECT COUNT(*) FROM sessions;" --remote
```

### Cleanup Job

The Worker includes an automated cleanup job that runs hourly to:
- Delete expired sessions and files
- Clean up incomplete uploads older than 48 hours
- Remove associated R2 storage objects

## Security Considerations

1. **JWT Secret**: Use a strong, unique secret for production
2. **TOTP**: Enable TOTP for sensitive deployments
3. **File Types**: The system accepts all file types - consider validation if needed
4. **Rate Limiting**: Consider adding rate limiting for production use
5. **Same origin**: The API sends no CORS headers, so other sites cannot call it from a browser

## Troubleshooting

### Common Issues

1. **Blank page or 404 for `/upload/`**: Make sure `npm run deploy` (not plain `wrangler deploy`) ran, so `dist/` was built
2. **Database Errors**: Verify D1 database is properly bound in `wrangler.jsonc`
3. **Storage Errors**: Ensure R2 bucket exists and is properly bound
4. **TOTP Issues**: Verify secrets are properly formatted and time is synchronized

### Debug Commands

```bash
# Test backend endpoints
curl https://your-worker.workers.dev/api/chest -X POST
```

## Scaling Considerations

- **D1**: Supports up to 100,000 reads/day and 50,000 writes/day on free tier
- **R2**: First 10GB storage free, then $0.015/GB/month
- **Workers**: 100,000 requests/day free, then $0.50 per million; static asset requests are free and do not invoke the Worker

For higher usage, consider Cloudflare's paid tiers.