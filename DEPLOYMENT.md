# PocketChest — Deployment guide

[English](DEPLOYMENT.md) | [繁體中文](DEPLOYMENT.zh-Hant.md) | [日本語](DEPLOYMENT.ja.md) | [PocketChest](README.md)

> Private, self-hosted sharing for files and text. One Cloudflare Worker, one R2 bucket, no database.

## 1. One-click deployment (recommended)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lpyedge/PocketChest)

1. Click the button, sign in to Cloudflare and let it connect to GitHub. It copies this repository into your account and sets up a Worker with an R2 bucket (`R2_STORAGE`), the rate-limit bindings and the hourly cron from `wrangler.jsonc`.
2. The form asks for **one** secret: `ADMIN_BOOTSTRAP_PASSWORD`. That is your PocketChest **Owner password** (at least 16 characters, not an example value). Choose it once, here. There is nothing else to generate, copy or back up.
3. Check that **Build** is `npm run build` and **Deploy** is `npm run deploy`, then deploy. `npm run deploy` makes the signing secret (`JWT_SECRET`) by itself the first time and keeps it afterwards. If the deploy command is changed to a bare `npx wrangler deploy`, the site answers `SERVER_MISCONFIGURED` until it is `npm run deploy` again.
4. Open `https://<your-worker>.<your-subdomain>.workers.dev/upload/`. The site creates the Owner from the password you chose and shows the **ordinary sign-in**: sign in with that password. It does not ask for it a second time to "set up".
5. Optional, later: in **Security settings** change the password, or add an authenticator app or a passkey. Choose the final hostname and set `PASSKEY_RP_ID` **before** you register a passkey ([operations](docs/OPERATIONS.md#passkey-domain)).

**Upgrading** asks for nothing: push the new code and let the same build run. `npm run deploy` sees that the installation is complete and deploys the code only; your password, secrets, shares and settings are not touched. Do not press the Deploy button again to upgrade.

**A successful deployment is not an acceptance test.** Check R2 concurrency, Cron, rate limits and large files on your own Cloudflare plan, as listed in [section 6](#6-check-the-installation).

## 2. Manual deployment

**You need** a Cloudflare account, Node.js 22.12 or newer (24 recommended) and npm. PocketChest is for new installations only; there is no migration from an older database version.

```bash
npm ci
npx wrangler login
npx wrangler r2 bucket create pocket-chest
# A different bucket name? Change bucket_name in wrangler.jsonc to match.
npm run deploy
```

`npm run deploy` asks for the Owner password **once**, hidden (at least 16 characters), generates the signing secret itself and deploys. In a script or CI, set `ADMIN_BOOTSTRAP_PASSWORD` in the environment instead of typing it. Then open `/upload/` and sign in with that password.

Running `npm run deploy` again is the upgrade: it asks for nothing and changes no secret. Before it changes anything it checks what Cloudflare says about the Worker and bucket named in `wrangler.jsonc`, and it **refuses** (changing nothing) when the answer is unclear: for example an Owner exists but the Worker has no signing secret (wrong account or Worker name), or a first setup was interrupted ([offline recovery](docs/RECOVERY.md)). Never remove the setup marker in R2 by hand.

## 3. Secrets and settings

| Name | Kind | Meaning |
| --- | --- | --- |
| `ADMIN_BOOTSTRAP_PASSWORD` | Worker secret you choose once | Your Owner password, at least 16 characters. The site creates the Owner from it on first use; it is never used again once the Owner exists, and it does not need to be removed. |
| `JWT_SECRET` | Worker secret made for you | Generated once by `npm run deploy`; never typed or backed up by you. Signs upload and download tokens and is the root the Worker derives the password key and the authenticator-seed key from. **Never replace it after the Owner exists:** the password and any authenticator would no longer verify (the deploy refuses to). |
| `PASSKEY_RP_ID` | Optional variable | The one hostname passkeys are bound to. Set it before registering a passkey. |
| `INSTANCE_ID` | Optional variable | Normally unset: an id for the rate-limit counters is created once in the bucket. |
| `R2_STORAGE` | R2 binding | Files and all metadata, in one private bucket. |
| `AUTH_LIMITER`, `RETRIEVE_LIMITER`, `UPLOAD_LIMITER`, `PART_LIMITER`, `PART_TOTAL_LIMITER`, `DOWNLOAD_LIMITER` | Rate-limit bindings | Per-client limits for sign-in, retrieval, uploads, upload parts and downloads. No extra database. |

There is no authenticator key to configure: if you set up an authenticator app, the Worker protects its seed with a key derived from `JWT_SECRET`. For local development, `npm run setup:local` writes `.dev.vars` with fresh random values. Never publish `.dev.vars`, and never use the example values anywhere real.

## 4. Build and deploy settings

With Workers Builds from GitHub, set **Build** to `npm run build` and **Deploy** to `npm run deploy` (the build step builds `dist/`; use `npm run deploy:code` instead if you only want to push code with Wrangler and manage the secrets yourself). The `dist/` folder is served as Workers Static Assets; the Worker itself handles `/api/*` only. A blank page or a 404 on `/upload/` means `dist/` was not built before deploying. Use one deployer per installation: either Workers Builds or your own `npm run deploy`, not both.

## 5. First use and daily use

- You sign in with the Owner password you chose. Change it any time in **Security settings** (at least 16 characters).
- Password, authenticator app and passkey are three **independent** ways to sign in: any one of them signs in on its own. An authenticator code is **not** a second factor on top of the password. Keep at least two set up, so one lost device does not lock you out. If every method is lost, see [recovery](docs/RECOVERY.md) (the password cannot be reset offline).
- Upload sessions end 24 hours after they start. Shares last 1, 3, 7 or 14 days, or are permanent; an hourly cleanup removes the expired ones. **Share records** (next to Security settings) lists your active shares, and lets you extend or revoke them.

## 6. Check the installation

- [ ] `/`, `/ja/`, `/en/`, `/upload/` and `/retrieve/` load.
- [ ] `/upload/` shows the ordinary sign-in (no second "set up" step) and your Owner password signs in.
- [ ] A text item and a small file upload, and download with the right content and file name.
- [ ] Every sign-in method you use works, and a method you switched off no longer signs in.
- [ ] The hourly Cron runs without errors, and rate limits answer `429` on the real Worker.
- [ ] A large file (more than 20 MiB) uploads and downloads.
- [ ] Passkeys work on the final hostname, after `PASSKEY_RP_ID` is set.

The full list is in [REMOTE_ACCEPTANCE.md](docs/REMOTE_ACCEPTANCE.md). Logs, the cleanup job, stored keys, custom domains and known limits are in [docs/OPERATIONS.md](docs/OPERATIONS.md).

## 7. Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Every `/api/*` call answers `SERVER_MISCONFIGURED` | The signing secret is missing: the site was deployed with a plain `wrangler deploy`. Run `npm run deploy`. |
| `/upload/` says there is no valid setup password | `ADMIN_BOOTSTRAP_PASSWORD` was never set, is shorter than 16 characters or is still an example value, and no Owner exists yet. Set it and deploy again. |
| `/upload/` says first setup was interrupted | A setup marker exists without an Owner. Run `node scripts/recover-bootstrap.mjs --bucket <name>` (see [recovery](docs/RECOVERY.md)). |
| `npm run deploy` refuses | It says why and has changed nothing; the usual causes are in section 2. |
| Authenticator setup or sign-in fails with `AUTH_NOT_CONFIGURED` | `JWT_SECRET` is missing, too short, or is not the value the authenticator was set up under. |
| Blank page or 404 on `/upload/` | `dist/` was not built before deploying (see section 4). |
| Storage errors | The R2 bucket does not exist, or `bucket_name` in `wrangler.jsonc` does not match it. |
| Passkey refused with `PASSKEY_DOMAIN_MISMATCH` | The request came from a hostname other than `PASSKEY_RP_ID`. |

## 8. Project origin and enhancements

Forked from [Hzao/PocketChest](https://github.com/Hzao/PocketChest). This fork adds a single Worker + R2-only architecture, one-click deployment, owner-only uploads, independent password / TOTP / passkey sign-in, security settings, a localized interface, better share links, rate limiting and cleanup. It is an independent fork; no endorsement by the upstream author is implied.
