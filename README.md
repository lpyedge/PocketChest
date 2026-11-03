# PocketChest

[English](README.md) | [繁體中文](README.zh-Hant.md) | [日本語](README.ja.md)

> Private, self-hosted sharing for files and text. One Cloudflare Worker, one R2 bucket, no database.

## 🚀 Deploy in minutes

[![Deploy with TapDeploy](https://raw.githubusercontent.com/lpyedge/TapDeploy/master/src/web/public/button.svg)](https://tapdeploy.27070.com/?config=https%3A%2F%2Fraw.githubusercontent.com%2Flpyedge%2FPocketChest%2Fmaster%2Fscripts%2Ftapdeploy.config.json)
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lpyedge/PocketChest)

**Recommended: TapDeploy.** It installs the latest prebuilt release into your own Cloudflare account from the browser. Nothing is built on your side, and upgrading is the same button again. Choose **Deploy to Cloudflare** if you want your own copy of the code to change.

| | TapDeploy (recommended) | Deploy to Cloudflare |
| --- | --- | --- |
| You need | A Cloudflare account | A Cloudflare account and a GitHub account |
| What happens | The latest release is installed as one Worker with its R2 bucket. You see every change before anything is written. | This repository is copied into your GitHub account, built by Workers Builds, and the R2 bucket is created. |
| Owner password | Type your own (at least 8 characters, with letters and digits), or leave it empty and read the generated one from your R2 bucket, then change it. | Generated on first setup and kept privately in your R2 bucket: read it there once, then change it. |
| Upgrade | Press the button again and choose **Upgrade existing**. Nothing to type; your password, shares, Owner and bucket are kept. | Merge the [Update from upstream](docs/OPERATIONS.md#update-from-upstream) pull request into your copy; the same build deploys it and asks for nothing. |
| Best for | Running PocketChest | Changing the code |

Already deployed with **Deploy to Cloudflare**? TapDeploy can upgrade that Worker. First disconnect its Git repository (Worker → **Settings** → **Build**), or its next build replaces the release again; then tick **Take over** on the review.

[Full deployment guide](DEPLOYMENT.md) · [Manual deployment](DEPLOYMENT.md#2-manual-deployment)

The TapDeploy button reads the ZIP of the latest release; every push to `master` that passes CI publishes a new one. **Not yet verified on a real Cloudflare account**: the Deploy to Cloudflare chain (the button prefilling `npm run deploy`, the secrets form, Workers Builds) has only been tested locally with simulated Cloudflare answers; a successful button deployment is not a production acceptance test.

## ✨ Features

- Password, authenticator app (TOTP) or passkey: three independent ways to sign in, any one is enough (an authenticator code is **not** a second step after the password). At least one stays on. An authenticator or passkey is optional and set up after signing in; the first one works as soon as it is confirmed.
- Owner-only uploads. Recipients use a retrieval code or a direct `#CODE` link, without signing in. **Share records** lists active shares, and lets the owner extend or revoke them.
- Text and large files (multipart), shares of 1, 3, 7, 14 or 30 days, 3 months (90 days) or permanent, hourly cleanup.
- Traditional Chinese, Japanese and English, including a static home page in each language.
- One Worker, Workers Static Assets and R2. No D1, KV or separate web service.

## 📦 How it works

1. Sign in at `/upload/` with any sign-in method that is on.
2. Add files or text, choose how long the share lasts, and finish.
3. Copy the direct link `/retrieve/#CODE`, or the retrieval page address and the code separately.
4. Recipients retrieve the files without an account.

## 🖼️ Screenshots

| | |
|:--:|:--:|
| <img src="docs/screenshots/home-en.png" alt="Home" width="420"><br>Home | <img src="docs/screenshots/login-en.png" alt="Owner sign-in" width="420"><br>Owner sign-in |
| <img src="docs/screenshots/upload-en.png" alt="Upload" width="420"><br>Upload | <img src="docs/screenshots/share-result-en.png" alt="Share result" width="420"><br>Share result |
| <img src="docs/screenshots/retrieve-en.png" alt="Retrieve" width="420"><br>Retrieve | <img src="docs/screenshots/share-records-en.png" alt="Share records" width="420"><br>Share records |
| <img src="docs/screenshots/security-settings-en.png" alt="Security settings" width="420"><br>Security settings | <img src="docs/screenshots/upload-en-mobile.png" alt="Upload (mobile)" width="200"> <img src="docs/screenshots/share-result-en-mobile.png" alt="Share result (mobile)" width="200"> <img src="docs/screenshots/share-records-en-mobile.png" alt="Share records (mobile)" width="200"> <img src="docs/screenshots/retrieve-en-mobile.png" alt="Retrieve (mobile)" width="200"> |


Captured from the current build by `npm run screenshots` (see [docs/SCREENSHOTS.md](docs/SCREENSHOTS.md)); the codes shown are throw-away test data.

## 🛡️ Security and current limits

- An upload session lasts 24 hours from its start; resuming after that is not supported.
- The password is stored as a salted HMAC under a key the Worker derives from its own secret (cheap enough for the Workers Free plan). Use a long password you use nowhere else; sign-in is also rate-limited and locks after repeated failures. The password cannot be reset offline: see [recovery](docs/RECOVERY.md).
- Everything here was tested locally (unit, Worker-runtime, end-to-end in a browser). Cloudflare-side checks (R2 concurrency, Cron, rate limits, passkeys on your domain, large files, the one-click chain) are still yours to run before relying on it: see [docs/REMOTE_ACCEPTANCE.md](docs/REMOTE_ACCEPTANCE.md).
- CSP is report-only and downloads do not support `Range` resume. Details: [docs/OPERATIONS.md](docs/OPERATIONS.md#known-limits).

## 🛠️ Development

```bash
npm ci
npm run setup:local        # writes .dev.vars with fresh random secrets
npm run preview            # build, then run the whole Worker on http://localhost:8787
```

The same checks run in CI:

```bash
npm run typecheck && npm run lint && npm run format:check
npm run test:unit && npm run test:worker && npm run test:contracts && npm run test:scripts
npm run test:e2e           # Playwright, desktop and 375px
npm run build && npx wrangler deploy --dry-run
```

[Architecture](docs/ARCHITECTURE.md) · [API](docs/API.md) · [Operations](docs/OPERATIONS.md) · [Owner recovery](docs/RECOVERY.md) · [Cloudflare acceptance](docs/REMOTE_ACCEPTANCE.md)

## 🔀 Project origin and enhancements

Forked from [Hzao/PocketChest](https://github.com/Hzao/PocketChest). This fork adds a single Worker + R2-only architecture, one-click deployment, owner-only uploads, independent password / TOTP / passkey sign-in, security settings, a localized interface, better share links, rate limiting and cleanup. It is an independent fork; no endorsement by the upstream author is implied.

Licensed under the repository's [LICENSE](LICENSE).
