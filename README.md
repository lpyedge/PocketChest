# PocketChest

> Secure, temporary file sharing. Upload files or text, get a code, share anywhere.

PocketChest is a modern file sharing service that runs as a single Cloudflare Worker. Share files and text content securely with automatic expiration and no account required.

## 💡 What is a "Chest"?

A **chest** is simply a collection of files and text that you upload together. Each chest gets a unique 6-character code (like `ABC123`) that you share with others to download everything inside it.

## ✨ Features

- 📤 **File & Text Sharing** - Upload files or paste text content; uploads are limited to the signed-in owner
- 📦 **Large File Support** - Handles files up to about 195GB (10,000 parts of 20MB) using multipart uploads to Cloudflare R2
- 🔐 **Secure Codes** - 6-character retrieval codes for access
- 🔗 **Ready-to-send Links** - After uploading, copy a direct link (`/retrieve/#ABC123`) or the page address plus code
- ⏰ **Auto Expiry** - Files expire after 1, 3, 7, or 14 days (or permanent)
- 🚀 **No Registration** - No accounts, just upload and share
- 🔐 **Owner Sign-in, three methods** - Password, authenticator app (TOTP) and passkey; any one that is switched on is enough
- 🌐 **Three languages** - 繁體中文, 日本語 and English, switchable without reloading
- 📱 **Responsive** - Works on desktop and mobile
- ⚡ **Fast** - Built on Cloudflare's global edge network

## 📺 Demo

### Upload & Share (15 seconds)
![Upload Demo](assets/pocket-chest-upload-demo.gif)

### Retrieve Files (10 seconds)  
![Retrieve Demo](assets/pocket-chest-retrieve-demo.gif)

## 🏗️ Architecture

One Cloudflare Worker serves everything from one domain:

| Path | Served by |
|------|-----------|
| `/` | Static home page (no JavaScript) |
| `/upload/` | Upload app (React) |
| `/retrieve/`, `/retrieve/#ABC123` | Retrieve app (React); the code in the `#` fragment is never sent to the server |
| `/assets/*` | Hashed JS/CSS from the Vite build |
| `/api/*` | Worker API; all data (files and chest manifests) lives in one R2 bucket |

- **Frontend**: React 19 + Tailwind CSS, built with Vite into `dist/` and served as Workers Static Assets
- **Backend**: TypeScript Worker + R2 Storage (no database), rate limiting bindings, hourly cron cleanup
- **Deployment**: `npm run deploy` builds the frontend and deploys the Worker and its assets together

## 🚀 Quick Start

For complete deployment instructions, see **[DEPLOYMENT.md](DEPLOYMENT.md)**. The API is documented in **[docs/API.md](docs/API.md)**.

### Prerequisites
- Cloudflare account
- Node.js 22.12+ (`.nvmrc` pins 24)

### Local Development

```bash
npm install
cp .dev.vars.example .dev.vars   # local secrets

# Option 1: build once and run everything on the Worker (http://localhost:8787)
npm run preview

# Option 2: hot reload — run the Worker and the Vite dev server side by side
npm run dev:worker   # API on http://localhost:8787
npm run dev          # frontend on http://localhost:5173, proxies /api to the Worker
```

### Checks

The same sequence runs in CI (`.github/workflows/ci.yml`):

```bash
npm ci
npm run typecheck
npm run lint
npm run format:check
npm run check:legacy        # no retired protocol left in shipped code
npm run test:unit           # web components, i18n
npm run test:worker         # Worker runtime: auth, uploads, downloads, cleanup
npm run test:contracts      # every documented route exists, retired ones answer 404
npm run test:e2e            # Playwright, desktop and 375px mobile
npm run build
npx wrangler deploy --dry-run --outdir .wrangler/dry-run
npm run audit:high
```

`npm test` runs the three Vitest groups. `test-results/report.json` is the machine-readable report written by `scripts/test-report.mjs`.

## 📁 Project Structure

```
PocketChest/
├── src/
│   ├── worker/                # Cloudflare Worker (API + cron cleanup)
│   │   ├── index.ts           # Routes and handlers
│   │   ├── storage.ts         # R2 key layout, chest manifests, cleanup
│   │   ├── types.ts
│   │   └── utils.ts
│   └── web/                   # Vite frontend (static home pages and two apps)
│       ├── index.html         # Static home page, zh-Hant (also /ja/ and /en/ as plain HTML)
│       ├── upload/            # Upload app (index.html, main.tsx, UploadApp.tsx)
│       ├── retrieve/          # Retrieve app (index.html, main.tsx, RetrieveApp.tsx)
│       └── shared/            # Components, hooks, API client, i18n catalogue, styles
├── public/                    # Copied into dist/ as-is (_headers, 404.html, favicon)
├── test/                      # Vitest groups: web/ + i18n (unit), contracts/, the rest (worker); e2e/ (Playwright)
├── scripts/                   # check-legacy.mjs, test-report.mjs, reset-owner-password.mjs (offline recovery)
├── docs/                      # API.md, RECOVERY.md, DEPENDENCIES.md, TEST_REPORT.md, IMPLEMENTATION_STATUS.md
├── .github/workflows/ci.yml   # The CI gate, in order
├── wrangler.jsonc             # Worker, assets, R2 and cron configuration
├── vite.config.ts
└── DEPLOYMENT.md
```

## 🔒 Security Features

- **Owner-only uploads** - Upload sessions need a signed-in owner session and a CSRF token
- **Three independent sign-in methods** - Password (PBKDF2-SHA256, 600,000 iterations), TOTP (seed sealed with AES-256-GCM) and passkeys (WebAuthn, public keys only); one method is always kept on
- **Lockouts and rate limits** - Per-method owner lockout plus per-client rate limiting bindings
- **Retrieval codes in the URL fragment** - `/retrieve/#CODE`; the code is never sent to the server
- **Short-lived download grants** - Each file download is authorized with a 60-second, per-file cookie
- **Auto Expiration** - Files automatically deleted after expiry
- **Automated Cleanup** - Hourly cron job removes expired chests, abandoned uploads and ended sessions
- **Recovery** - Offline command only, see [docs/RECOVERY.md](docs/RECOVERY.md)

## 🚢 Deployment

See **[DEPLOYMENT.md](DEPLOYMENT.md)** for complete deployment instructions including:
- Single Worker deployment (API + static frontend)
- R2 storage setup and the three secrets
- First-time setup and enabling the sign-in methods
- Custom domain configuration and the passkey domain
- Environment variables
- Troubleshooting guide

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## 📄 License

MIT License - see LICENSE file for details. Use at your own risk.