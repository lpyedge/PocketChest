# Architecture and project layout

One Cloudflare Worker serves everything from one domain. All data (files, chest manifests, the owner record, sessions) lives in one R2 bucket; there is no database.

| Path | Served by |
|------|-----------|
| `/`, `/ja/`, `/en/` | Static home pages (plain HTML, no JavaScript) |
| `/upload/` | Upload app (React) |
| `/retrieve/`, `/retrieve/#ABC123` | Retrieve app (React); the code in the `#` fragment is never sent to the server |
| `/assets/*` | Hashed JS/CSS from the Vite build |
| `/api/*` | Worker API ([API.md](API.md)) |

- **Frontend**: React 19 + Tailwind CSS, built by Vite into `dist/` and served as Workers Static Assets.
- **Backend**: a TypeScript Worker, R2, rate limiting bindings and an hourly cron cleanup.
- **Languages**: Traditional Chinese, Japanese and English. Each language file is its own chunk; the static home pages have one HTML file per language.

## Project layout

```
PocketChest/
├── src/
│   ├── worker/                # Cloudflare Worker (API + cron cleanup)
│   │   ├── index.ts           # Routes and handlers
│   │   ├── storage.ts         # R2 key layout, chest manifests, cleanup
│   │   ├── session.ts         # Upload session state machine (compare-and-swap)
│   │   ├── config.ts          # Refuses example secrets
│   │   └── auth/              # Owner record, sessions, password, TOTP, passkeys, throttling
│   └── web/                   # Vite frontend
│       ├── index.html, ja/, en/   # Static home pages
│       ├── upload/            # Upload app
│       ├── retrieve/          # Retrieve app
│       └── shared/            # Components, hooks, API client, i18n catalogue, styles
├── public/                    # Copied into dist/ as-is (_headers, 404.html, favicon)
├── test/                      # Vitest: web/ (unit), contracts/, the rest (Worker runtime); e2e/ (Playwright)
├── scripts/                   # check-legacy, test-report, setup-local, capture-screenshots, recovery tools
├── docs/                      # API, operations, recovery, screenshots, test and review records
├── assets/screenshots/        # Images used by the READMEs
├── .github/workflows/ci.yml   # The CI gate, in order
└── wrangler.jsonc             # Worker, assets, R2, rate limits and cron
```

## Security design in brief

- **Owner-only uploads**: an upload session needs a signed-in owner session and a CSRF token.
- **Three independent sign-in methods**: password (salted HMAC-SHA256 under a key derived from the Worker root secret), TOTP (an independent sign-in method; the seed is made only when the owner sets it up, sealed with AES-256-GCM under another derived key) and passkeys (WebAuthn, public keys only). At least one stays on. A method that is off cannot sign in or re-enter a session.
- **Lockouts and rate limits**: a per-method owner lockout plus per-client rate limiting bindings.
- **Retrieval codes in the URL fragment**: `/retrieve/#CODE` is never sent to the server.
- **Short-lived download grants**: each file download is authorized with a 60-second cookie limited to that file.
- **Expiry**: shares last 1, 3, 7 or 14 days, or are permanent. Expiry is enforced on every request and by an hourly cleanup.
- **Recovery**: an offline command only; see [RECOVERY.md](RECOVERY.md).
