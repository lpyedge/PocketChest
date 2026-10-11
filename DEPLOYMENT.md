# PocketChest — Deployment guide

[English](DEPLOYMENT.md) | [繁體中文](DEPLOYMENT.zh-Hant.md) | [日本語](DEPLOYMENT.ja.md) | [PocketChest](README.md)

> Private, self-hosted sharing for files and text. One Cloudflare Worker, one R2 bucket, no database.

## 1. One-click deployment (recommended)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lpyedge/PocketChest)

1. Click the button, sign in to Cloudflare and let it connect to GitHub. It copies this repository into your account and sets up a Worker with an R2 bucket (`R2_STORAGE`), the rate-limit bindings and the hourly cron from `wrangler.jsonc`.
2. The form asks for **nothing**. You do not choose or type an Owner password, and there is no signing secret to generate.
3. Check that **Build** is `npm run build` and **Deploy** is `npm run deploy:installer`, then deploy. The build runs once; the installer makes the signing secret (`JWT_SECRET`) itself, makes the R2 bucket if it is missing, checks that the bucket is private, and arms first setup. Use `npm run deploy:installer` here, not a bare `npx wrangler deploy`: a bare deploy leaves the site answering `SERVER_MISCONFIGURED`.
4. The deploy log ends with the address, the bucket, the object key and the steps below. Open `https://<your-worker>.<your-subdomain>.workers.dev/upload/`. The site makes your **Owner password** on first use. **It is never shown on the website.** Get it from the bucket:
   1. Cloudflare dashboard → **R2** → open the bucket named in the log.
   2. **Objects** → open `auth/initial-owner-password.txt` → **Download**.
   3. Sign in to the site with that password.
5. Change the password at once in **Security settings** (at least 8 characters, not an obvious or repeated one). After a successful change the stored copy is removed automatically. If the change fails, the file stays.
6. Optional, later: add an authenticator app or a passkey. Choose the final hostname and set `PASSKEY_RP_ID` **before** you register a passkey ([operations](docs/OPERATIONS.md#passkey-domain)).

**Upgrading** asks for nothing: push the new code and let the same build run. `npm run deploy:installer` sees that the installation is complete and deploys the code only; your password, secrets, shares and settings are not touched. Do not press the Deploy button again to upgrade.

**A successful deployment is not an acceptance test.** Check R2 concurrency, Cron, rate limits and large files on your own Cloudflare plan, as listed in [section 6](#6-check-the-installation).

## 2. Manual deployment

**You need** a Cloudflare account, Node.js 22.12 or newer (24 recommended) and npm. PocketChest is for new installations only; there is no migration from an older database version.

```bash
npm ci
npx wrangler login
npm run deploy
```

`npm run deploy` builds once, then runs the installer. It asks for nothing. It checks what Cloudflare says about the Worker and the bucket named in `wrangler.jsonc`, and **refuses** (changing nothing) when the answer is unclear. On a first install it creates the bucket if it is missing, makes the signing secret, checks that the bucket is private (r2.dev off, no custom domain), arms first setup, and then checks that the site is ready. It prints the same steps as in section 1 for getting the Owner password from the bucket. A different bucket name? Change `bucket_name` in `wrangler.jsonc` first.

Running `npm run deploy` again is the upgrade: it changes no secret, Owner or bucket data. An Owner that exists but a Worker with no signing secret (wrong account or Worker name), or a first setup that was interrupted, is refused with the reason ([offline recovery](docs/RECOVERY.md)). Never remove the setup marker in R2 by hand.

### Deploying with GitHub Actions

If your repository is a copy or fork of PocketChest, `.github/workflows/deploy-manual.yml` ("Deploy (manual)") installs or upgrades from the **Actions** tab. It runs only when you start it, runs the tests and a dry run first, and then runs the same installer as `npm run deploy`.

1. Settings → Secrets and variables → Actions: add `CLOUDFLARE_API_TOKEN` (Workers Scripts: Edit and Workers R2 Storage: Edit, for your account only) and `CLOUDFLARE_ACCOUNT_ID`. There is no Owner password to add. Optionally create an Environment named `production` with required reviewers to approve every run.
2. Actions → Deploy (manual) → Run workflow. The Worker and bucket are the ones named in `wrangler.jsonc`.
3. The job log ends with the address, the bucket and the object key of the first password. Get the password from the bucket as in section 1. Later runs are upgrades: they change no secret, Owner or bucket data.

Use this **or** Workers Builds / `npm run deploy` for an installation, not both.

## 3. Secrets, objects and settings

| Name | Kind | Meaning |
| --- | --- | --- |
| `auth/initial-owner-password.txt` | Private R2 object, made by the Worker | Your first Owner password, generated once (32 random bytes). Read it in the R2 dashboard, change your password, and the file is removed. Never shown by the site, the API or a build log. |
| `JWT_SECRET` | Worker secret made for you | Generated once by the installer; never typed or backed up by you. Signs upload and download tokens and is the root the Worker derives the password key and the authenticator-seed key from. **Never replace it after the Owner exists:** the password and any authenticator would no longer verify (the deploy refuses to). |
| `SETUP_ARMED` | Worker secret set by the installer | Turned on only after the bucket was proven private. It lets the Worker make the first password. Do not set it by hand. |
| `ADMIN_BOOTSTRAP_PASSWORD` | Not used any more | The Worker never reads it and the installer never asks for or sets it. Installations made with the older form keep working: their Owner already exists and an upgrade never removes this secret. |
| `PASSKEY_RP_ID` | Optional variable | The one hostname passkeys are bound to. Set it before registering a passkey. |
| `INSTANCE_ID` | Optional variable | Normally unset: an id for the rate-limit counters is created once in the bucket. |
| `R2_STORAGE` | R2 binding | Files and all metadata, in one private bucket. |
| `AUTH_LIMITER`, `RETRIEVE_LIMITER`, `UPLOAD_LIMITER`, `PART_LIMITER`, `PART_TOTAL_LIMITER`, `DOWNLOAD_LIMITER` | Rate-limit bindings | Per-client limits for sign-in, retrieval, uploads, upload parts and downloads. No extra database. |

The bucket must stay private: r2.dev access off and no custom domain. The installer checks this before it arms first setup. The Worker's own `workers.dev` address is separate from the bucket and is what you use to open the site.

There is no authenticator key to configure: if you set up an authenticator app, the Worker protects its seed with a key derived from `JWT_SECRET`. For local development, `npm run setup:local` writes `.dev.vars` with fresh random values. Never publish `.dev.vars`, and never use the example values anywhere real.

## 4. Build and deploy settings

With Workers Builds from GitHub, set **Build** to `npm run build` and **Deploy** to `npm run deploy:installer`. The build step builds `dist/`; the deploy step runs the installer, which deploys it. `npm run deploy` is the same two steps in one command for local use, and `npm run deploy:code` only pushes the code with Wrangler. The `dist/` folder is served as Workers Static Assets; the Worker itself handles `/api/*` only. A blank page or a 404 on `/upload/` means `dist/` was not built before deploying. Use one deployer per installation: either Workers Builds or your own `npm run deploy`, not both.

## 5. First use and daily use

- Sign in with the Owner password. The first one is in the bucket object named in section 1; change it at once in **Security settings** (at least 8 characters).
- Password, authenticator app and passkey are three **independent** ways to sign in: any one of them signs in on its own. An authenticator code is **not** a second factor on top of the password. Keep at least two set up, so one lost device does not lock you out. If every method is lost, see [recovery](docs/RECOVERY.md) (the password cannot be reset offline).
- Upload sessions end 24 hours after they start. Shares last 1, 3, 7 or 14 days, or are permanent; an hourly cleanup removes the expired ones. **Share records** (next to Security settings) lists your active shares, and lets you extend or revoke them.

## 6. Check the installation

- [ ] `/`, `/ja/`, `/en/`, `/upload/` and `/retrieve/` load.
- [ ] `/upload/` shows the ordinary sign-in (no second "set up" step). The first password from the bucket signs in, and after you change it, the new one does.
- [ ] The bucket shows r2.dev off and no custom domain.
- [ ] A text item and a small file upload, and download with the right content and file name.
- [ ] Every sign-in method you use works, and a method you switched off no longer signs in.
- [ ] The hourly Cron runs without errors, and rate limits answer `429` on the real Worker.
- [ ] A large file (more than 20 MiB) uploads and downloads.
- [ ] Passkeys work on the final hostname, after `PASSKEY_RP_ID` is set.

The full list is in [REMOTE_ACCEPTANCE.md](docs/REMOTE_ACCEPTANCE.md). Logs, the cleanup job, stored keys, custom domains and known limits are in [docs/OPERATIONS.md](docs/OPERATIONS.md).

## 7. Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Every `/api/*` call answers `SERVER_MISCONFIGURED` | The signing secret is missing: the site was deployed with a plain `wrangler deploy`. Run `npm run deploy` (or the installer deploy command). |
| `/upload/` says setup is not available yet | First setup is not armed: the installer has not finished. Run the deploy again; it says why when it refuses. |
| The deploy refuses with `bucket-not-private` | r2.dev access is on, or a custom domain is attached to the bucket. Turn both off in the R2 dashboard and deploy again. |
| `/upload/` says first setup was interrupted | A setup marker exists without an Owner. Run `node scripts/recover-bootstrap.mjs --bucket <name>` (see [recovery](docs/RECOVERY.md)). |
| The deploy says it is "not ready" | The log lists what is missing (sign-in not ready, Owner or first-password object not in the bucket). Fix it and run the deploy again. |
| `npm run deploy` refuses | It says why and has changed nothing; the usual causes are in section 2. |
| Authenticator setup or sign-in fails with `AUTH_NOT_CONFIGURED` | `JWT_SECRET` is missing, too short, or is not the value the authenticator was set up under. |
| Blank page or 404 on `/upload/` | `dist/` was not built before deploying (see section 4). |
| Storage errors | The R2 bucket does not exist, or `bucket_name` in `wrangler.jsonc` does not match it. |
| Passkey refused with `PASSKEY_DOMAIN_MISMATCH` | The request came from a hostname other than `PASSKEY_RP_ID`. |

## 8. Project origin and enhancements

Forked from [Hzao/PocketChest](https://github.com/Hzao/PocketChest). This fork adds a single Worker + R2-only architecture, one-click deployment, owner-only uploads, independent password / TOTP / passkey sign-in, security settings, a localized interface, better share links, rate limiting and cleanup. It is an independent fork; no endorsement by the upstream author is implied.
