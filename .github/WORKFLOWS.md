# GitHub Actions Configuration

## CI (`ci.yml`)

Runs on pushes to `master`, `dev` and `claude/**`, and on pull requests to `master` and `dev`. `dev` is the development branch; `master` is the released branch.

**Jobs:**

1. **Lint, test and build**: TypeScript type checking for the Worker and the web app, ESLint, Prettier, the Worker test suite (Vitest + `@cloudflare/vitest-plugin`), the Vite production build, and a `wrangler deploy --dry-run` to verify the Worker bundle.
2. **Security Audit**: `npm audit` and, on pull requests, the dependency review action.

No secrets are required. Tests use the JWT secret defined in `vitest.config.mts`, and the dry run never contacts Cloudflare.

## Update from upstream (`upstream-update.yml`)

For copies and forks only (it does nothing in `lpyedge/PocketChest` itself). Started by hand or weekly; merges the official `master` into a new branch and opens a pull request. No Cloudflare access, no deploy, no auto merge; token permissions are `contents: write` and `pull-requests: write`. See [OPERATIONS.md](../docs/OPERATIONS.md#update-from-upstream).

## Running the same checks locally

```bash
npm ci
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
```
