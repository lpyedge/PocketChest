# Isolated Cloudflare real-device acceptance (TASK-31)

[English](REMOTE_ACCEPTANCE.md) | [繁體中文](REMOTE_ACCEPTANCE.zh-Hant.md)

**Status: BLOCKED (not run)**

This document explains why a production launch cannot be claimed yet, and which resources unblock it. This run produced no real-device results. Results from the local Miniflare test environment cannot stand in for real-device results.

## What blocks it

1. **No Cloudflare credentials**: `npx wrangler whoami` reports not signed in, and `CLOUDFLARE_API_TOKEN` is not set in the environment.
2. **Restricted network**: the container's egress proxy refuses connections to `workers.cloudflare.com` and `sparrow.cloudflare.com`, so deploying or signing in is impossible.
3. **No test domain**: the passkey RP ID must be a real domain; locally only `localhost` is available.

## Resources needed to unblock it

- An isolated Cloudflare test account (or test sub-account), and an API token limited to that account (minimum Workers, R2 and DNS permissions).
- A test domain or sub-domain (for example `pocket-acceptance.example.com`) that points at the Worker. It must **not** be a production domain.
- A new, empty R2 bucket whose name differs from production.
- Either network access from the container to the Cloudflare API, or you run this checklist yourself on a machine that can reach it.

## Acceptance checklist (to be run)

| No. | Item | Method | Result |
|------|------|------|------|
| R1 | Deploys from zero: empty bucket, the owner password is never typed, `npm run deploy` makes the signing secret itself | As DEPLOYMENT.md (`npm run deploy`, GitHub Actions, Deploy Button, once each) | BLOCKED |
| R2 | The first visit to `/upload/` is the ordinary sign-in (the owner is created automatically, with no second setup step); the owner is never overwritten by the initial password afterwards | HTTP and browser; record status codes | BLOCKED |
| R1b | Upgrade: a redeploy asks for nothing, and secrets, the owner, bucket data and settings stay exactly the same; a mismatched Worker or bucket is refused | Redeploy once in the isolated environment from R1 | BLOCKED |
| R1c | **One-click flow**: whether the Deploy Button prefills `npm run deploy` as its deploy command, and whether Workers Builds gets Cloudflare credentials during the build and runs the installer | Isolated account; record actual behaviour | BLOCKED (not yet verified) |
| R3 | Password, TOTP and passkey each sign in on their own; switching one of the others off does not affect it | Real browser and authenticator | BLOCKED |
| R4 | A passkey signs in on a real device or a browser authenticator | Manual; record the device and browser | BLOCKED |
| R5 | R2 conditional writes succeed only once under concurrency (first setup, owner changes) | Concurrent requests; compare results | BLOCKED |
| R6 | The cron runs on schedule and its summary has no errors | `wrangler tail`, with timestamps | BLOCKED |
| R7 | Downloads before and after expiry: available before, 404 after | Inject a test share with a short lifetime | BLOCKED |
| R8 | The download cookie expires after 60 seconds and covers only one file | HTTP; record the Set-Cookie attributes | BLOCKED |
| R9 | The rate limiter answers 429 with Retry-After when exceeded | Low-rate requests; no stress testing | BLOCKED |
| R10 | Abandoned multipart uploads leave nothing unfinished | Upload in parts, abort, compare with R2 | BLOCKED |
| R11 | Record Worker CPU, memory and R2 operation counts | Dashboard and sampled `wrangler tail` | BLOCKED |
| R12 | Recovery drill after an interrupted first setup (isolated bucket; offline password reset is impossible and is not on the list) | docs/RECOVERY.md | BLOCKED |

> This version does **not** run a password CPU benchmark or stress tests: passwords are stored with a cheap HMAC, and guessing is limited by the sign-in lockout and by a key that exists only in the Worker. R11 records normal usage only.

## Conditions that prevent shipping

Any of the following means the product cannot be launched:

- R1, R2, R3, R5 or R6 has not passed.
- Any test leaves the last sign-in method switched off, or makes a shared file disappear within its validity period.
- Any path lets a caller reach files across sessions, or from a query string alone.
- A test uses the production R2 bucket, or uses the production domain for passkey tests.

## Security constraints

- No deletion, expiry or forced-reset experiments on the production bucket.
- After the tests, delete the test bucket and its secrets, or label them as retained and isolated.
- The acceptance logs must not contain passwords, seeds, cookies or full challenges.
