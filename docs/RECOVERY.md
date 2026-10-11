# Recovery (Owner)

[English](RECOVERY.md) | [繁體中文](RECOVERY.zh-Hant.md) | [日本語](RECOVERY.ja.md)

This document explains what you can and cannot do when the Owner cannot sign in.

## The short answer: the password cannot be reset offline

The Owner password is stored as `HMAC-SHA256-KEYED-V1`: a random salt plus a key derived from the Worker's root secret (`JWT_SECRET`). Cloudflare does not return the value of a Worker secret to anyone, so **a tool that only has R2 access cannot write a password record the Worker would accept**.

Therefore:

- `node scripts/reset-owner-password.mjs` **only explains this and exits with an error**. It neither reads nor writes R2.
- This is deliberate, not a gap. We do not report fake success, and we do not add a public "forgot password" entry or a permanent back door. On first setup the Worker generates the Owner password itself (the private R2 object `auth/initial-owner-password.txt`), and that password cannot be used for recovery either.
- You do not need to, and should not, back up or paste `JWT_SECRET` to get offline reset.

## Day to day: change the password after signing in

A signed-in Owner changes the password in **Security settings → Change password** (a recent re-entry is required). Every other signed-in session then ends.

The site offers three **independent** ways to sign in: password, authenticator app (TOTP) and passkey. Any one of them signs in on its own (an authenticator code is **not** a second factor). As long as one of them works, you can sign in and manage the rest in Security settings. We recommend keeping a second method as a backup.

## When no sign-in method works

There is currently no safe offline reset path. The deployer can consider these options:

1. Rule out a temporary problem first: is the passkey on its original domain, is the authenticator's clock correct, is sign-in locked (wait for the lock to expire)?
2. If the Owner record is damaged or cannot be recovered, and you **accept clearing the Owner**: the deployer, using their own Cloudflare credentials, deletes `auth/owner.json` and `auth/bootstrap-marker`, and confirms that `SETUP_ARMED` is still `yes`. The next time the site is opened, the Owner is created again: if `auth/initial-owner-password.txt` still exists, its password is used; otherwise a new one is generated and kept in the same object. This ends every Owner session and invalidates every bound authenticator and passkey, but leaves `codes/`, `sessions/` and file data untouched. This is destructive: back up `auth/owner.json` first and do it in a maintenance window.
3. If `JWT_SECRET` was replaced or lost: the password and any authenticator can no longer be verified. Handle it as in point 2. Issued upload and download tokens also stop working.

## First setup was interrupted (a marker exists, no Owner)

When first setup runs, the Worker prepares the password, claims `auth/bootstrap-marker`, and then writes `auth/owner.json`. If the marker was written but the Owner write failed, the site asks for offline recovery. Use the deployer tool to **remove only the marker**, so first setup can run once more:

```bash
npx wrangler login
node scripts/recover-bootstrap.mjs --bucket pocket-chest
```

- It acts only when the marker exists and the Owner does not. If an Owner exists it refuses, and the marker stays.
- The tool **creates no Owner and needs no password**. After it runs, first setup is completed by the Worker (it needs `SETUP_ARMED`, set by the deployer).
- There is no anonymous HTTP route to set up again. `wrangler r2 object delete` is not a conditional delete, so run this in a maintenance window and pause public sign-in while you do.
- Never remove the marker by hand in any other situation. If an Owner exists, never delete the marker.

## Out of scope for this document

- Changing Cloudflare account settings, or creating or deleting R2 buckets.
- A public "forgot password" HTTP API. There is none.

## Tests

- `test/recovery-cli.spec.ts`: the offline reset is refused, and nothing is read or written; the existing Owner and password stay exactly as they are.
- `test/bootstrap-recovery.spec.ts`: an interrupted first setup only clears the marker; an existing Owner, a missing marker, or an Owner appearing during the clear are refused or reported.
- In production, tests that change the Owner record must **not** run automatically; a full manual rehearsal happens in an isolated R2 bucket.
