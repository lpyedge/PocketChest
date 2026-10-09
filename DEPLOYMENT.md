# PocketChest — Deployment guide

[English](DEPLOYMENT.md) | [繁體中文](DEPLOYMENT.zh-Hant.md) | [日本語](DEPLOYMENT.ja.md) | [PocketChest](README.md)

> Private, self-hosted sharing for files and text. One Cloudflare Worker, one R2 bucket, no database.

## 1. One-click deployment (recommended)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lpyedge/PocketChest)

1. Click the button, sign in to Cloudflare and let it connect to GitHub. It copies this repository into your account and sets up a Worker with an R2 bucket (`R2_STORAGE`), the rate-limit bindings and the hourly cron from `wrangler.jsonc`.
2. The secrets form lists `JWT_SECRET`, `AUTH_ENCRYPTION_KEY` and `ADMIN_BOOTSTRAP_PASSWORD`, pre-filled with the placeholders from `.dev.vars.example`. **Replace each one with your own random value** (commands in [section 2](#2-manual-deployment)). A deployment that keeps a placeholder is refused: the API answers `SERVER_MISCONFIGURED`, and the owner cannot be created with a placeholder password.
3. Check that **Build** is `npm run build` and **Deploy** is `npx wrangler deploy`, then deploy.
4. Open `https://<your-worker>.<your-subdomain>.workers.dev/upload/`. While there is no owner and setup is enabled, the page asks for the setup password. Enter `ADMIN_BOOTSTRAP_PASSWORD` to create the owner; that password is the owner's password until you change it.
5. **Close setup now.** Delete the `ADMIN_BOOTSTRAP_PASSWORD` secret (Worker → Settings → Variables and Secrets): without it setup cannot run. Then, in the repository the button created in your GitHub account, change `BOOTSTRAP_ENABLED` to `"false"` in `wrangler.jsonc` and commit, so the next build keeps it off. Changing it only in the dashboard is overwritten by the next build.
6. Open **Security settings** and set a password of your own, then add an authenticator app or a passkey. Choose the final hostname and set `PASSKEY_RP_ID` **before** you register a passkey ([operations](docs/OPERATIONS.md#passkey-domain)).

**A successful deployment is not an acceptance test.** Check PBKDF2 CPU use, R2 concurrency, Cron, rate limits and large files on your own Cloudflare plan, as listed in [section 6](#6-check-the-installation). Do not weaken the password hash to fit the Free plan.

## 2. Manual deployment

**You need** a Cloudflare account, Node.js 22.12 or newer (24 recommended), npm, and an empty R2 bucket. PocketChest is for new installations only; there is no migration from an older database version.

```bash
npm ci
npx wrangler login
npx wrangler r2 bucket create pocket-chest
# A different bucket name? Change bucket_name in wrangler.jsonc to match.
```

Generate three **different** values and keep them somewhere private:

```bash
openssl rand -base64 48   # JWT_SECRET
openssl rand -base64 32   # AUTH_ENCRYPTION_KEY: must decode to exactly 32 bytes
openssl rand -base64 24   # ADMIN_BOOTSTRAP_PASSWORD: at least 16 characters
# no openssl: node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

```bash
npx wrangler secret put JWT_SECRET
npx wrangler secret put AUTH_ENCRYPTION_KEY
npx wrangler secret put ADMIN_BOOTSTRAP_PASSWORD
```

`BOOTSTRAP_ENABLED` is `"true"` in the repository, for a first installation. Build and deploy:

```bash
npm run build
npx wrangler deploy        # or: npm run deploy, which builds first
```

Open `/upload/` and create the owner, then **close setup** before public use:

```bash
npx wrangler secret delete ADMIN_BOOTSTRAP_PASSWORD
# set BOOTSTRAP_ENABLED to "false" in wrangler.jsonc, then:
npx wrangler deploy
```

Never remove the setup marker in R2 to reopen setup. If setup was interrupted, use [offline recovery](docs/RECOVERY.md).

## 3. Secrets and settings

| Name | Kind | Meaning |
| --- | --- | --- |
| `JWT_SECRET` | Worker secret | Signs upload and download tokens. At least 24 characters, random, never an example value. |
| `AUTH_ENCRYPTION_KEY` | Worker secret | Base64 of exactly 32 random bytes; seals the authenticator seed. Keep a backup: without it the authenticator must be set up again. |
| `ADMIN_BOOTSTRAP_PASSWORD` | One-time Worker secret | At least 16 characters. Creates the owner; **delete it afterwards**. |
| `BOOTSTRAP_ENABLED` | `wrangler.jsonc` variable | `"true"` only for the first installation; `"false"` once the owner exists. |
| `PASSKEY_RP_ID` | Optional variable | The one hostname passkeys are bound to. Set it before registering a passkey. |
| `R2_STORAGE` | R2 binding | Files and all metadata, in one private bucket. |
| `AUTH_LIMITER`, `RETRIEVE_LIMITER`, `UPLOAD_LIMITER`, `PART_LIMITER`, `PART_TOTAL_LIMITER`, `DOWNLOAD_LIMITER` | Rate-limit bindings | Per-client limits for sign-in, retrieval, uploads, upload parts and downloads. No extra database. |

For local development, `npm run setup:local` writes `.dev.vars` with fresh random values. Never publish `.dev.vars`, and never use the example values anywhere real.

## 4. Build and deploy settings

With Workers Builds from GitHub, set **Build** to `npm run build` and **Deploy** to `npx wrangler deploy`. Do not use `npm run deploy` there: it builds again. The `dist/` folder is served as Workers Static Assets; the Worker itself handles `/api/*` only. A blank page or a 404 on `/upload/` means `dist/` was not built before deploying.

## 5. First setup and daily use

- The setup password becomes the owner's password. Change it in **Security settings** (at least 16 characters).
- Password, authenticator app and passkey can each sign in on their own. Keep at least two set up, so one lost device does not lock you out. If every method is lost, see [offline recovery](docs/RECOVERY.md).
- Upload sessions end 24 hours after they start. Shares last 1, 3, 7 or 14 days, or are permanent; an hourly cleanup removes the expired ones.

## 6. Check the installation

- [ ] `/`, `/ja/`, `/en/`, `/upload/` and `/retrieve/` load.
- [ ] The owner was created once, `ADMIN_BOOTSTRAP_PASSWORD` is deleted and `BOOTSTRAP_ENABLED` is `"false"` in the deployed configuration.
- [ ] A text item and a small file upload, and download with the right content and file name.
- [ ] Every sign-in method you use works, and a method you switched off no longer signs in.
- [ ] Password sign-in runs within the CPU allowance of your Workers plan (measure it; see [known limits](docs/OPERATIONS.md#known-limits)).
- [ ] The hourly Cron runs without errors, and rate limits answer `429` on the real Worker.
- [ ] A large file (more than 20 MiB) uploads and downloads.
- [ ] Passkeys work on the final hostname, after `PASSKEY_RP_ID` is set.

The full list is in [REMOTE_ACCEPTANCE.md](docs/REMOTE_ACCEPTANCE.md). Logs, the cleanup job, stored keys, custom domains and known limits are in [docs/OPERATIONS.md](docs/OPERATIONS.md).

## 7. Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Every `/api/*` call answers `SERVER_MISCONFIGURED` | `JWT_SECRET` is missing, too short or still an example value. |
| Setup answers `BOOTSTRAP_MISCONFIGURED` | `ADMIN_BOOTSTRAP_PASSWORD` is shorter than 16 characters or still an example value. |
| Setup answers `BOOTSTRAP_DISABLED` | `BOOTSTRAP_ENABLED` is not `"true"`, or the secret is not set. |
| Authenticator setup fails with `AUTH_NOT_CONFIGURED` | `AUTH_ENCRYPTION_KEY` is missing or not base64 of 32 bytes. |
| Blank page or 404 on `/upload/` | `dist/` was not built before deploying (see section 4). |
| Storage errors | The R2 bucket does not exist, or `bucket_name` in `wrangler.jsonc` does not match it. |
| Passkey refused with `PASSKEY_DOMAIN_MISMATCH` | The request came from a hostname other than `PASSKEY_RP_ID`. |

## 8. Project origin and enhancements

Forked from [Hzao/PocketChest](https://github.com/Hzao/PocketChest). This fork adds a single Worker + R2-only architecture, one-click deployment, owner-only uploads, independent password / TOTP / passkey sign-in, security settings, a localized interface, better share links, rate limiting and cleanup. It is an independent fork; no endorsement by the upstream author is implied.
