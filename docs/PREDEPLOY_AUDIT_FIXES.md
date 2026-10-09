# Pre-deploy audit (2026-10-10) — what changed

| ID | Change | Test |
| --- | --- | --- |
| F-01 | Removed `BOOTSTRAP_ENABLED` from `.dev.vars.example`; only `wrangler.jsonc` sets it, so the Deploy Button asks for exactly three secrets. | `test/contracts/deploy-config.spec.ts` |
| F-02 | The Worker hashes the password **before** claiming `auth/bootstrap-marker`, so a CPU/hash failure leaves nothing claimed and setup can simply be retried. New deployer-only `scripts/recover-bootstrap.mjs` creates the first Owner when the marker exists and the Owner does not (no anonymous HTTP re-init; the marker is never removed). | `test/bootstrap-recovery.spec.ts` (hash failure, owner Put failure, retry, concurrency, read-back verification) |
| F-03 | `docs/RECOVERY.md` no longer says R2 lacks conditional writes; it says the `wrangler r2 object put` CLI has no equivalent of the Worker SDK's conditional write, hence the maintenance window. | `test/contracts/recovery-docs.spec.ts` |
| F-04 | GitHub Actions bumped to `checkout@v5`, `setup-node@v5`, `upload-artifact@v5` (Node 20 deprecation). CSP stays Report-Only, no `Range`, 24h upload sessions: unchanged known limits. | CI |

## Not verified here

Deploy Button flow, real Cloudflare CPU for PBKDF2 (Free 10 ms limit), R2 concurrency, Cron, Passkey and cross-PoP rate limits need an isolated Cloudflare account (TASK-31).
