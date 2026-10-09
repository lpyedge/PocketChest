# PocketChest

> Secure, temporary file sharing. Upload files or text, get a code, share anywhere.

PocketChest is a modern file sharing service that runs as a single Cloudflare Worker. Share files and text content securely with automatic expiration and no account required.

## 💡 What is a "Chest"?

A **chest** is simply a collection of files and text that you upload together. Each chest gets a unique 6-character code (like `ABC123`) that you share with others to download everything inside it.

## ✨ Features

- 📤 **File & Text Sharing** - Upload files or paste text content (optionally restrict uploads to trusted users with TOTP authentication)
- 📦 **Large File Support** - Handles files up to 200GB using multipart uploads to Cloudflare R2
- 🔐 **Secure Codes** - 6-character retrieval codes for access
- 🔗 **Ready-to-send Links** - After uploading, copy a direct link (`/retrieve/#ABC123`) or the page address plus code
- ⏰ **Auto Expiry** - Files expire after 1, 3, 7, or 15 days (or permanent)
- 🚀 **No Registration** - No accounts, just upload and share
- 🔐 **Optional TOTP Auth** - Restrict access with authenticator apps  
- 📱 **Responsive** - Works on desktop and mobile
- ⚡ **Fast** - Built on Cloudflare's global edge network

## 📺 Demo

### Upload & Share (15 seconds, with TOTP protected)
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

- **Frontend**: React 18 + Tailwind CSS, built with Vite into `dist/` and served as Workers Static Assets
- **Backend**: TypeScript Worker + R2 Storage (no database), hourly cron cleanup
- **Deployment**: `npm run deploy` builds the frontend and deploys the Worker and its assets together

## 🚀 Quick Start

For complete deployment instructions, see **[DEPLOYMENT.md](DEPLOYMENT.md)**. The API is documented in **[docs/API.md](docs/API.md)**.

### Prerequisites
- Cloudflare account
- Node.js 20+

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

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

## 📁 Project Structure

```
PocketChest/
├── src/
│   ├── worker/                # Cloudflare Worker (API + cron cleanup)
│   │   ├── index.ts           # Routes and handlers
│   │   ├── storage.ts         # R2 key layout, chest manifests, cleanup
│   │   ├── types.ts
│   │   └── utils.ts
│   └── web/                   # Vite frontend (three HTML entry points)
│       ├── index.html         # Static home page
│       ├── upload/            # Upload app (index.html, main.tsx, UploadApp.tsx)
│       ├── retrieve/          # Retrieve app (index.html, main.tsx, RetrieveApp.tsx)
│       └── shared/            # Components, hooks, API client, styles
├── public/                    # Copied into dist/ as-is (_headers, _redirects, 404.html, favicon)
├── test/                      # Worker tests (Vitest + @cloudflare/vitest-pool-workers)
├── scripts/                   # generate-secrets.js, test-ci.sh
├── docs/API.md                # API reference
├── wrangler.jsonc             # Worker, assets, R2 and cron configuration
├── vite.config.ts
└── DEPLOYMENT.md
```

## 🔒 Security Features

- **TOTP Authentication** - Optional two-factor authentication
- **JWT Session Tokens** - Secure session management
- **Auto Expiration** - Files automatically deleted after expiry
- **Automated Cleanup** - Hourly cron job removes expired chests and abandoned uploads
- **Input Validation** - File type and size restrictions

## 🚢 Deployment

See **[DEPLOYMENT.md](DEPLOYMENT.md)** for complete deployment instructions including:
- Single Worker deployment (API + static frontend)
- R2 storage setup
- TOTP authentication setup
- Custom domain configuration
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