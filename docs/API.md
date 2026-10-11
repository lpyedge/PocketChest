# PocketChest API contract (protocol v2)

[English](API.md) | [繁體中文](API.zh-Hant.md)

> Status: **TASK-00 frozen draft**. This document is the only API contract.
> Markers: `[implemented]` the current code provides it; `[TODO-TASK-xx]` not implemented yet, delivered by the named task.
> The code still speaks the old protocol (see `docs/API-legacy-v1.md`, kept only as a baseline record; deleted after TASK-28).

## Common rules

- **Same origin**: the front end and the API share one hostname, and **no CORS headers are set**.
- **Error format** (all 4xx/5xx):

  ```json
  { "error": "safe message", "code": "FIXED_CODE" }
  ```

  `error` is for debugging only; the front end translates by `code` alone. It must never contain a stack trace, an R2 key, a secret or SQL.
- **Sensitive endpoints** (sign-in, pickup, download authorization) return `Cache-Control: no-store`. Every API response carries `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. `[TODO-TASK-13]`
- **A URL must never contain** a JWT, a retrieval code, a cookie, a password or a one-time code. `[TODO-TASK-10/11]`
- **Endpoints that change state through a cookie**: must pass the Origin check and send `X-PocketChest-CSRF`. `[TODO-TASK-13]`
- **Status codes**: 400 malformed request · 401 not signed in · 403 permission / CSRF / Origin · 404 not found or expired (one answer for both, so existence cannot be enumerated) · 409 state conflict / CAS conflict · 413 over the limit · 429 rate limited · 500 internal error (fixed message).

## Error codes

| code | HTTP | Meaning |
|---|---|---|
| `INVALID_REQUEST` | 400 | The request format or a field is not valid |
| `INVALID_CODE` | 400 | The retrieval code format is not valid |
| `INVALID_SESSION` | 400 | The upload session ID and token do not match |
| `AUTH_REQUIRED` | 401 | Authentication is missing |
| `AUTH_INVALID` | 401 | Authentication failed (token or cookie invalid or expired) |
| `AUTH_INVALID_CREDENTIALS` | 401 | Password, one-time code or passkey verification failed `[password implemented]` |
| `TOKEN_MISMATCH` | 403 | The token and the session or file do not belong together |
| `CSRF_REJECTED` | 403 | Origin or CSRF header does not match `[TODO-TASK-13]` |
| `REAUTH_REQUIRED` | 403 | A recent re-entry is needed (5 minutes) `[implemented for sensitive operations, TASK-19/20]` |
| `AUTH_METHOD_DISABLED` | 403 | That sign-in method is switched off `[implemented]` |
| `PASSKEY_DOMAIN_MISMATCH` | 403 | This hostname is not the configured passkey domain (`PASSKEY_RP_ID`) `[implemented]` |
| `AUTH_METHOD_NOT_CONFIGURED` | 409 | Switching on a method that was never set up `[implemented]` |
| `LAST_AUTH_METHOD` | 409 | The last usable method cannot be switched off `[implemented]` |
| `CONFLICT` | 409 | R2 CAS conflict: read again and retry `[TODO-TASK-04]` |
| `SESSION_NOT_FOUND` | 404 | The upload session does not exist or is already completed |
| `FILE_NOT_IN_SESSION` | 400 | The submitted file does not belong to this session |
| `FILE_NOT_FOUND` | 404 | The file does not exist or is not in this share |
| `CHEST_NOT_FOUND` | 404 | The retrieval code does not exist or has expired |
| `TOTP_REQUIRED` / `TOTP_INVALID` / `TOTP_NOT_CONFIGURED` | 401/500 | **Old protocol**, deleted in TASK-28 |
| `AUTH_TEMPORARILY_LOCKED` | 429 | The method is paused (counted per owner, each method separately), with `Retry-After` `[implemented]` |
| `RATE_LIMITED` | 429 | The source exceeded its rate limit (approximate, counted per Cloudflare location), with `Retry-After` `[implemented]` |
| `PAYLOAD_TOO_LARGE` | 413 | Over the file count, total size or per-file size limit `[TODO-TASK-09]` |
| `CODE_GENERATION_FAILED` | 500 | No retrieval code could be allocated after repeated collisions |
| `INTERNAL_ERROR` | 500 | Any other error |

## Endpoints

### Public and sign-in

| # | Method | Path | Permission | Status | Notes |
|---|---|---|---|---|---|
| 1 | GET | `/api/auth/methods` | Public | [implemented] | Returns the `setup` state and an enabled flag for each of the three methods. On a fresh installation with first setup armed (`SETUP_ARMED`), the first call creates the Owner. The Worker generates the password and keeps it only in a private R2 object (see below). |
| 3 | POST | `/api/auth/bootstrap` | — | [removed] | The site has no "create owner" entry any more: no route lets a caller choose an owner or a password, so every call answers `404`. |
| 4 | POST | `/api/auth/login/password` | Public | [implemented] | On success, issues the Owner cookie. |
| 5 | POST | `/api/auth/login/totp` | Public | [implemented] | As above. |
| 6 | POST | `/api/auth/passkey/login/options` | Public | [implemented] | One-time challenge. |
| 7 | POST | `/api/auth/passkey/login/verify` | Public | [implemented] | On success, issues the Owner cookie. |
| 8 | GET | `/api/auth/session` | Cookie | [TODO-TASK-13] | Returns `{authenticated, csrfToken?}`. |
| 9 | POST | `/api/auth/logout` | Cookie + CSRF | [TODO-TASK-13] | Revokes the session. |
| 10 | POST | `/api/auth/reauth/password` | Cookie + CSRF | [implemented] | Updates `reauthenticatedAt`. |
| 11 | POST | `/api/auth/reauth/totp` | Cookie + CSRF | [implemented] | As above. |
| 12 | POST | `/api/auth/reauth/passkey/options` `…/verify` | Cookie + CSRF | [implemented] | As above. A method that is switched off always answers `403 AUTH_METHOD_DISABLED` (sign-in and re-entry alike). |
| 33 | POST | `/api/auth/activate/password` | Cookie + CSRF | [implemented] | Proves the owner still holds a switched-off password, only in order to switch it back on; does not open the re-entry window. |
| 34 | POST | `/api/auth/activate/totp` | Cookie + CSRF | [implemented] | As above, with a one-time code. |
| 35 | POST | `/api/auth/activate/passkey/options` | Cookie + CSRF | [implemented] | As above, passkey challenge. |
| 36 | POST | `/api/auth/activate/passkey/verify` | Cookie + CSRF | [implemented] | As above, passkey verification; after success the method can be switched on for 5 minutes. |

### Owner security settings

| # | Method | Path | Permission | Status | Notes |
|---|---|---|---|---|---|
| 13 | GET | `/api/admin/security` | Cookie | [implemented] | Returns a summary only, never hashes, seeds or public keys. |
| 14 | PATCH | `/api/admin/security/methods` | Cookie + CSRF + recent re-entry | [implemented] | `{method, enabled}`, one method at a time. Switching a method on also needs that method's activation proof, otherwise `403 ACTIVATION_PROOF_REQUIRED`. |
| 15 | POST | `/api/admin/security/password` | Cookie + CSRF + recent re-entry | [implemented] | Changes the password and rotates the session. Later passwords must be at least 8 characters. |
| 16 | POST | `/api/admin/security/totp/prepare` | Cookie + CSRF + recent re-entry | [implemented] | Makes a new seed and challenge. |
| 17 | POST | `/api/admin/security/totp/confirm` | Cookie + CSRF + recent re-entry | [implemented] | Switches over after a new one-time code is verified. |
| 18 | POST | `/api/admin/passkeys/register/options` | Cookie + CSRF + recent re-entry | [implemented] | Registration challenge. |
| 19 | POST | `/api/admin/passkeys/register/verify` | Cookie + CSRF + recent re-entry | [implemented] | Adds a credential. |
| 20 | DELETE | `/api/admin/passkeys/{id}` | Cookie + CSRF + recent re-entry | [implemented] | Cannot delete the last usable method. |

### Owner share records

| # | Method | Path | Permission | Status | Notes |
|---|---|---|---|---|---|
| 37 | GET | `/api/admin/shares?limit=&cursor=` | Cookie | [implemented] | Current active shares; `limit` 1–50 (default 20). Returns `{shares:[{sessionId, retrievalCode, createdAt, expiresAt, fileCount, totalSize}], cursor}`. `cursor` is `null` only on the last page. Unfinished, expired, damaged or inconsistent records are not listed (this endpoint repairs nothing). A page may hold fewer than `limit` items, so keep following `cursor`. `Cache-Control: no-store`. |
| 39 | PATCH | `/api/admin/shares/{sessionId}` | Cookie + CSRF | [implemented] | `{validityDays: 1\|3\|7\|14\|-1}`. Extends an unexpired share from now, or makes it permanent (`-1`). Returns `{expiresAt}`. Never shortens (`409 EXPIRY_NOT_LATER`); already expired `409 SHARE_EXPIRED`; revoked, removed or unfinished `404 SHARE_NOT_FOUND`. Order: write the new index → CAS-update the session → update the manifest → delete the old index. If it fails midway the share is briefly refused; repeating the same request (same expiry time: 200) or the cron after the old index expires repairs it. |
| 38 | DELETE | `/api/admin/shares/{sessionId}` | Cookie + CSRF | [implemented] | Revokes a share: session `COMPLETED → REVOKED` (CAS, final state). Then the retrieval code, download authorizations and downloads are refused at once (including retrieval tokens issued earlier). Then the code, the index and the files are removed. If removal fails it still answers `200 {revoked:true, contentRemoved:false}`, and a `revoked/{sessionId}` marker makes the cron retry. No such share, or unfinished or removed, answers `404 SHARE_NOT_FOUND`. A download already in progress is not guaranteed to stop. |

### Upload

| # | Method | Path | Permission | Status | Notes |
|---|---|---|---|---|---|
| 22 | POST | `/api/upload-sessions` | Owner cookie + CSRF | [implemented] | Returns `{sessionId, uploadToken, expiresIn}`. |
| 23 | POST | `/api/upload-sessions/{id}/files` | Upload token | [implemented] | |
| 24 | POST | `/api/upload-sessions/{id}/multipart/create` | Upload token | [implemented] | |
| 25 | PUT | `/api/upload-sessions/{id}/multipart/{fileId}/parts/{n}` | Multipart token | [implemented] | |
| 26 | POST | `/api/upload-sessions/{id}/multipart/{fileId}/complete` | Multipart token | [implemented] | |
| 27 | POST | `/api/upload-sessions/{id}/multipart/{fileId}/abort` | Multipart token | [implemented] | |
| 28 | POST | `/api/upload-sessions/{id}/complete` | Upload token | [implemented] | |

> **Upload tokens and the owner session (T06)**: an upload token issued by `POST /api/upload-sessions` carries `osh`, the SHA-256 of the owner-session id that issued it (never the cookie itself). File upload, multipart create, multipart complete and `complete` read R2 twice more (the owner session and the owner record) to confirm the session is still valid (not signed out, not past the absolute lifetime, `authVersion` unchanged), otherwise `401 AUTH_INVALID`. An old token without `osh` is refused the same way (the upload must start again). To keep R2 reads within the Free plan, individual part uploads are not checked (a part written after sign-out cannot be published, because multipart complete and `complete` fail). `cancel` and multipart `abort` still work after sign-out, only to release resources. Idle time does not count as signed out. A single write already in progress is not guaranteed to stop.

### Pickup and download

| # | Method | Path | Permission | Status | Notes |
|---|---|---|---|---|---|
| 29 | POST | `/api/retrieve` | Public (the body holds the retrieval code) | [implemented] | `{"code":"ABC123"}`; returns the file list and a retrieval credential. |
| 31 | POST | `/api/download/authorize` | `Authorization: Bearer <retrieval credential>` | [implemented] | Body `{"fileId"}`; issues a 60-second cookie limited to its path. |
| 32 | GET | `/api/download/{fileId}` | Download cookie | [implemented] | Native streaming; does not accept `?token=`, `?filename=` or Bearer. |

## Success and failure examples

### POST /api/upload-sessions/{id}/complete

Request: `{"fileIds":["…"],"validityDays":7}`. `validityDays` accepts only `1`, `3`, `7`, `14` (two weeks) or `-1` (permanent); any other value answers `400 INVALID_REQUEST`. A permanent share has `expiryDate` `null`.

```http
200 OK
{"retrievalCode":"ABC123","expiryDate":"2026-10-16T00:00:00.000Z"}
```

Failure: `404 {"error":"Session not found or already completed","code":"SESSION_NOT_FOUND"}`

### GET /api/auth/methods

```http
200 OK
Cache-Control: no-store

{"setup":"ready","methods":{"password":{"enabled":true},"totp":{"enabled":false},"passkey":{"enabled":false}}}
```

`setup`: `ready` (the owner exists; the ordinary sign-in is shown), `initializing` (another request is creating the owner right now; try again shortly), `password-missing` (no owner, and first setup is not armed yet), `recovery-required` (first setup was interrupted; the deployer handles it as in `docs/RECOVERY.md`), `failed` (not completed this time, nothing was claimed, can be retried). Once the owner exists, the initial password is never used or overwrites it.

Never returns `passwordHash`, `encryptedSecret`, `credentials` or `seed`.

### POST /api/auth/login/password

```http
200 OK
Set-Cookie: __Host-pc_owner=<opaque>; HttpOnly; Secure; SameSite=Strict; Path=/

{"authenticated":true}
```

Failure: `401 {"error":"Invalid credentials","code":"AUTH_INVALID_CREDENTIALS"}`. Locked: `429 {"error":"Please try again later","code":"AUTH_TEMPORARILY_LOCKED"}` with a positive `Retry-After`.

### POST /api/retrieve (implemented)

```http
POST /api/retrieve
Content-Type: application/json

{"code":"ABC123"}

200 OK
{"files":[{"fileId":"<uuid>","filename":"a.txt","size":12}],"chestToken":"<short-lived retrieval credential>","expiryDate":null}
```

Failure: `400 {"error":"Invalid retrieval code format","code":"INVALID_CODE"}`. Not found or expired: `404 {"error":"Retrieval code not found or expired","code":"CHEST_NOT_FOUND"}`.

### POST /api/download/authorize (implemented)

```http
POST /api/download/authorize
Authorization: Bearer <retrieval credential>
Content-Type: application/json

{"fileId":"<uuid>"}

200 OK
Set-Cookie: pc_dl_<fileId>=<short-lived>; HttpOnly; Secure; SameSite=Strict; Path=/api/download/<fileId>; Max-Age=60
```

### GET /api/download/{fileId} (implemented)

```http
200 OK
Cookie: pc_dl_<fileId>=<short-lived>
Content-Disposition: attachment; filename="safe.txt"; filename*=UTF-8''...
Content-Type: application/octet-stream
```

## Acceptance mapping (AC-00-1, AC-00-2)

- AC-00-1: every new API has its method, path, permission, error codes and examples (the tables above and this section).
- The new protocol has no `?code=`, `?token=`, `/api/retrieve/{code}`, `/api/chest` or `/api/config`, and no compatibility alias for them. These paths now answer `404 NOT_FOUND`, verified by `test/contracts`.
