# PocketChest API 合約（新協定 v2）

> 狀態：**TASK-00 凍結稿**。本文件是唯一的 API 合約。
> 欄位標記：`[已實作]` 目前程式已提供；`[TODO-TASK-xx]` 尚未實作，由指定 Task 交付。
> 目前程式仍是舊協定（見 `docs/API-legacy-v1.md`，僅作基準記錄，TASK-28 後刪除）。

## 共通規則

- **同源**：前端與 API 同一網域，**不設定任何 CORS 標頭**。
- **錯誤格式**（所有 4xx/5xx）：

  ```json
  { "error": "safe message", "code": "FIXED_CODE" }
  ```

  `error` 只供除錯，前端只依 `code` 映射翻譯。不得含 Stack、R2 Key、Secret、SQL。
- **敏感端點**（認證、取件、下載授權）回 `Cache-Control: no-store`；所有 API 回 `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`。 `[TODO-TASK-13]`
- **URL 不得含** JWT、取件碼、Cookie、Password、OTP。 `[TODO-TASK-10/11]`
- **修改型 Cookie 端點**：必須通過 Origin 檢查，並帶 `X-PocketChest-CSRF`。 `[TODO-TASK-13]`
- **狀態碼**：400 格式錯誤 · 401 未認證 · 403 權限／CSRF／Origin · 404 不存在或已過期（統一，避免枚舉） · 409 狀態衝突／CAS 衝突 · 413 超過上限 · 429 限流 · 500 內部錯誤（固定訊息）。

## 錯誤代碼表

| code | HTTP | 含義 |
|---|---|---|
| `INVALID_REQUEST` | 400 | 請求格式或欄位不合法 |
| `INVALID_CODE` | 400 | 取件碼格式不合法 |
| `INVALID_SESSION` | 400 | 上傳 Session ID 與 Token 不符 |
| `AUTH_REQUIRED` | 401 | 缺少認證 |
| `AUTH_INVALID` | 401 | 認證失敗（Token／Cookie 無效或過期） |
| `AUTH_INVALID_CREDENTIALS` | 401 | Password／TOTP／Passkey 驗證失敗 `[Password 已實作]` |
| `TOKEN_MISMATCH` | 403 | Token 與 Session／檔案不屬於同一組 |
| `CSRF_REJECTED` | 403 | Origin 或 CSRF Header 不符 `[TODO-TASK-13]` |
| `REAUTH_REQUIRED` | 403 | 需近期重新驗證（5 分鐘）`[判斷已實作，TASK-19/20 的敏感操作使用]` |
| `AUTH_METHOD_DISABLED` | 403 | 該登入方式已停用 `[已實作]` |
| `AUTH_METHOD_NOT_CONFIGURED` | 409 | 方式未設定卻要求啟用 `[TODO-TASK-19]` |
| `LAST_AUTH_METHOD` | 409 | 不可停用最後一種可用方式 `[TODO-TASK-19]` |
| `CONFLICT` | 409 | R2 CAS 衝突，請重新讀取後再試 `[TODO-TASK-04]` |
| `SESSION_NOT_FOUND` | 404 | 上傳 Session 不存在或已完成 |
| `FILE_NOT_IN_SESSION` | 400 | 提交的檔案不屬於此 Session |
| `FILE_NOT_FOUND` | 404 | 檔案不存在或不在此分享中 |
| `CHEST_NOT_FOUND` | 404 | 取件碼不存在、已過期 |
| `TOTP_REQUIRED` / `TOTP_INVALID` / `TOTP_NOT_CONFIGURED` | 401/500 | **舊協定**，TASK-28 刪除 |
| `AUTH_TEMPORARILY_LOCKED` | 429 | 方法暫停，附 `Retry-After` `[TODO-TASK-16]` |
| `RATE_LIMITED` | 429 | 來源超出限流，附 `Retry-After` `[TODO-TASK-16]` |
| `PAYLOAD_TOO_LARGE` | 413 | 超過檔數／容量／大小上限 `[TODO-TASK-09]` |
| `CODE_GENERATION_FAILED` | 500 | 多次撞碼仍無法分配取件碼 |
| `INTERNAL_ERROR` | 500 | 其他錯誤 |

## Endpoint 清單

### 公開與登入

| # | Method | Path | 權限 | 狀態 | 說明 |
|---|---|---|---|---|---|
| 1 | GET | `/api/config` | 公開 | [已移除] | 由 #2 取代；TOTP 開關不再存在。 |
| 2 | GET | `/api/auth/methods` | 公開 | [已實作] | 回三種方式的啟用旗標與 `setupRequired`。 |
| 3 | POST | `/api/auth/bootstrap` | 公開，需 Bootstrap 條件 | [TODO-TASK-12] | 僅首次初始化。 |
| 4 | POST | `/api/auth/login/password` | 公開 | [已實作] | 成功發出 Owner Cookie。 |
| 5 | POST | `/api/auth/login/totp` | 公開 | [TODO-TASK-15] | 同上。 |
| 6 | POST | `/api/auth/passkey/login/options` | 公開 | [TODO-TASK-18] | 一次性 Challenge。 |
| 7 | POST | `/api/auth/passkey/login/verify` | 公開 | [TODO-TASK-18] | 成功發出 Owner Cookie。 |
| 8 | GET | `/api/auth/session` | Cookie | [TODO-TASK-13] | 回 `{authenticated, csrfToken?}`。 |
| 9 | POST | `/api/auth/logout` | Cookie + CSRF | [TODO-TASK-13] | 撤銷 Session。 |
| 10 | POST | `/api/auth/reauth/password` | Cookie + CSRF | [已實作] | 更新 `reauthenticatedAt`。 |
| 11 | POST | `/api/auth/reauth/totp` | Cookie + CSRF | [TODO-TASK-15] | 同上。 |
| 12 | POST | `/api/auth/reauth/passkey/options` `…/verify` | Cookie + CSRF | [TODO-TASK-18] | 同上。 |

### Owner 安全設定

| # | Method | Path | 權限 | 狀態 | 說明 |
|---|---|---|---|---|---|
| 13 | GET | `/api/admin/security` | Cookie | [TODO-TASK-19] | 只回摘要，不回 Hash／Seed／公鑰。 |
| 14 | PATCH | `/api/admin/security/methods` | Cookie + CSRF + 近期 reauth | [TODO-TASK-19] | `{method, enabled}`，單一方式。 |
| 15 | POST | `/api/admin/security/password` | Cookie + CSRF + 近期 reauth | [TODO-TASK-20] | 修改密碼，輪替 Session。 |
| 16 | POST | `/api/admin/security/totp/prepare` | Cookie + CSRF + 近期 reauth | [TODO-TASK-21] | 產生新 Seed 與 Challenge。 |
| 17 | POST | `/api/admin/security/totp/confirm` | Cookie + CSRF + 近期 reauth | [TODO-TASK-21] | 驗證新 OTP 後切換。 |
| 18 | POST | `/api/admin/passkeys/register/options` | Cookie + CSRF + 近期 reauth | [TODO-TASK-17] | 註冊 Challenge。 |
| 19 | POST | `/api/admin/passkeys/register/verify` | Cookie + CSRF + 近期 reauth | [TODO-TASK-17] | 新增 Credential。 |
| 20 | DELETE | `/api/admin/passkeys/{id}` | Cookie + CSRF + 近期 reauth | [TODO-TASK-19] | 不得刪最後一個有效方式。 |

### 上傳

| # | Method | Path | 權限 | 狀態 | 說明 |
|---|---|---|---|---|---|
| 21 | POST | `/api/chest` | 舊 | [已移除] | 由 #22 取代。 |
| 22 | POST | `/api/upload-sessions` | Owner Cookie + CSRF | [已實作] | 回 `{sessionId, uploadToken, expiresIn}`。 |
| 23 | POST | `/api/upload-sessions/{id}/files` | Upload Token | [已實作] | |
| 24 | POST | `/api/upload-sessions/{id}/multipart/create` | Upload Token | [已實作] | |
| 25 | PUT | `/api/upload-sessions/{id}/multipart/{fileId}/parts/{n}` | Multipart Token | [已實作] | |
| 26 | POST | `/api/upload-sessions/{id}/multipart/{fileId}/complete` | Multipart Token | [已實作] | |
| 27 | POST | `/api/upload-sessions/{id}/multipart/{fileId}/abort` | Multipart Token | [已實作] | |
| 28 | POST | `/api/upload-sessions/{id}/complete` | Upload Token | [已實作] | |

### 取件與下載

| # | Method | Path | 權限 | 狀態 | 說明 |
|---|---|---|---|---|---|
| 29 | POST | `/api/retrieve` | 公開（Body 含取件碼） | [已實作] | `{"code":"ABC123"}`，回檔案清單與取件憑證。 |
| 30 | GET | `/api/retrieve/{code}` | — | [已移除] | 取件碼不再出現在 URL。 |
| 31 | POST | `/api/download/authorize` | `Authorization: Bearer <取件憑證>` | [已實作] | Body `{"fileId"}`；下發 60 秒、限 Path 的 Cookie。 |
| 32 | GET | `/api/download/{fileId}` | 下載 Cookie | [已實作] | 原生串流；不接受 `?token=`、`?filename=`、Bearer。 |

## 成功與失敗樣本

### POST /api/upload-sessions/{id}/complete

```http
200 OK
{"retrievalCode":"ABC123","expiryDate":"2026-10-16T00:00:00.000Z"}
```

失敗：`404 {"error":"Session not found or already completed","code":"SESSION_NOT_FOUND"}`

### GET /api/auth/methods

```http
200 OK
Cache-Control: no-store

{"setupRequired":false,"password":true,"totp":false,"passkey":false}
```

不得回傳 `passwordHash`、`encryptedSecret`、`credentials`、`seed`。

### POST /api/auth/login/password

```http
200 OK
Set-Cookie: __Host-pc_owner=<opaque>; HttpOnly; Secure; SameSite=Strict; Path=/

{"authenticated":true}
```

失敗：`401 {"error":"Invalid credentials","code":"AUTH_INVALID_CREDENTIALS"}`；鎖定：`429 {"error":"Please try again later","code":"AUTH_TEMPORARILY_LOCKED"}` 並附正數 `Retry-After`。

### POST /api/retrieve（已實作）

```http
POST /api/retrieve
Content-Type: application/json

{"code":"ABC123"}

200 OK
{"files":[{"fileId":"<uuid>","filename":"a.txt","size":12}],"chestToken":"<短效取件憑證>","expiryDate":null}
```

失敗：`400 {"error":"Invalid retrieval code format","code":"INVALID_CODE"}`；不存在或過期：`404 {"error":"Retrieval code not found or expired","code":"CHEST_NOT_FOUND"}`。

### POST /api/download/authorize（已實作）

```http
POST /api/download/authorize
Authorization: Bearer <取件憑證>
Content-Type: application/json

{"fileId":"<uuid>"}

200 OK
Set-Cookie: pc_dl_<fileId>=<短效>; HttpOnly; Secure; SameSite=Strict; Path=/api/download/<fileId>; Max-Age=60
```

### GET /api/download/{fileId}（已實作）

```http
200 OK
Cookie: pc_dl_<fileId>=<短效>
Content-Disposition: attachment; filename="safe.txt"; filename*=UTF-8''...
Content-Type: application/octet-stream
```

## 驗收對照（AC-00-1、AC-00-2）

- AC-00-1：每條新 API 均有 Method／Path／權限／錯誤碼與樣本（上表與本節）。
- AC-00-2：新協定沒有 `?code=`、`?token=`、`/api/retrieve/{code}` 的相容要求，這三者已移除。舊的 `/api/chest`、`/api/config` 與 TOTP 舊認證已於 TASK-14 刪除，不保留別名。
