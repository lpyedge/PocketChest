# GitHub Actions Configuration

## CI (`ci.yml`)

Runs on pushes and pull requests to `master`, `main` and `develop`.

**Jobs:**

1. **Lint, test and build**: TypeScript type checking for the Worker and the web app, ESLint, Prettier, the Worker test suite (Vitest + `@cloudflare/vitest-plugin`), the Vite production build, and a `wrangler deploy --dry-run` to verify the Worker bundle.
2. **Security Audit**: `npm audit` and, on pull requests, the dependency review action.

No secrets are required. Tests use the JWT secret defined in `vitest.config.mts`, and the dry run never contacts Cloudflare.

## Running the same checks locally

```bash
npm ci
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
```
