# PocketChest

[English](README.md) | [繁體中文](README.zh-Hant.md) | [日本語](README.ja.md)

> Private, self-hosted sharing for files and text. One Cloudflare Worker, one R2 bucket, no database.

## 🚀 Deploy in minutes

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lpyedge/PocketChest)

**One-click deployment** · [Full deployment guide](DEPLOYMENT.md) · [Manual deployment](DEPLOYMENT.md#2-manual-deployment)

The button clones this repository into your GitHub account, builds it with Workers Builds and creates the R2 bucket. You enter three secrets, create the owner once, then close setup. The guide walks through each step, including what to check afterwards: a successful button deployment is not a production acceptance test.

## ✨ Features

- Password, authenticator app (TOTP) or passkey: each can sign in on its own; at least one stays on.
- Owner-only uploads. Recipients use a retrieval code or a direct `#CODE` link, without signing in.
- Text and large files (multipart), shares of 1, 3, 7 or 14 days or permanent, hourly cleanup.
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
| <img src="assets/screenshots/home-en.png" alt="Home" width="420"><br>Home | <img src="assets/screenshots/login-en.png" alt="Owner sign-in" width="420"><br>Owner sign-in |
| <img src="assets/screenshots/upload-en.png" alt="Upload" width="420"><br>Upload | <img src="assets/screenshots/share-result-en.png" alt="Share result" width="420"><br>Share result |
| <img src="assets/screenshots/retrieve-en.png" alt="Retrieve" width="420"><br>Retrieve | <img src="assets/screenshots/security-settings-en.png" alt="Security settings" width="420"><br>Security settings |

<img src="assets/screenshots/upload-en-mobile.png" alt="Upload (mobile)" width="200"> <img src="assets/screenshots/retrieve-en-mobile.png" alt="Retrieve (mobile)" width="200">

Captured from the current build by `npm run screenshots` (see [docs/SCREENSHOTS.md](docs/SCREENSHOTS.md)); the codes shown are throw-away test data.

## 🛡️ Security and current limits

- An upload session lasts 24 hours from its start; resuming after that is not supported.
- Password hashing is CPU-heavy. Do not assume the Workers Free plan can run it; test your plan.
- Cloudflare-side checks (R2 concurrency, Cron, rate limits, passkeys on your domain, large files) are still yours to run before relying on it.
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
npm run test:unit && npm run test:worker && npm run test:contracts
npm run test:e2e           # Playwright, desktop and 375px
npm run build && npx wrangler deploy --dry-run
```

[Architecture](docs/ARCHITECTURE.md) · [API](docs/API.md) · [Operations](docs/OPERATIONS.md) · [Owner recovery](docs/RECOVERY.md) · [Cloudflare acceptance](docs/REMOTE_ACCEPTANCE.md)

## 🔀 Project origin and enhancements

Forked from [Hzao/PocketChest](https://github.com/Hzao/PocketChest). This fork adds a single Worker + R2-only architecture, one-click deployment, owner-only uploads, independent password / TOTP / passkey sign-in, security settings, a localized interface, better share links, rate limiting and cleanup. It is an independent fork; no endorsement by the upstream author is implied.

Licensed under the repository's [LICENSE](LICENSE).
