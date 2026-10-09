# 離線密碼恢復（Owner）

本文件說明在**所有登入方式都無法使用**（忘記密碼、丟失 Authenticator、Passkey 不可用）時，部署者如何重設 Owner 密碼。

## 原則

- 恢復只能由部署者在**離線維護窗口**執行，使用部署者自己持有的 Cloudflare 憑證。**Worker 沒有任何 HTTP 恢復入口**，也不接受日常登入 Token 作為恢復權限。
- 不存在「萬能密碼」或永久後門。`ADMIN_BOOTSTRAP_PASSWORD` 只用於首次初始化，不能用來恢復。
- 恢復不會清空 R2 Bucket，也不會改動 `codes/`、`files/` 或其他分享資料。
- Cloudflare 憑證**不得**放進前端、Worker 變數或本倉庫。

## 何時使用

1. 確認確實無法登入：密碼、TOTP、Passkey 都不可用。先嘗試一般登入與 Passkey。
2. 確認是部署者本人（不是有人在登入頁提出請求）。
3. 排定維護窗口，並通知可能受影響的人。

## 步驟

### 1. 暫停登入入口

在維護窗口期間，停止對外的登入流程（例如暫時關閉 `/upload/` 的部署或將其指向維護頁）。
理由：R2 本身支援條件寫入，Worker 內部也以此（CAS）保護 Owner 紀錄；但本工具使用的 `wrangler r2 object put` 沒有提供與 Worker SDK 相同的條件寫入操作，腳本只能在寫入前重新讀取比對。如果登入同時改寫 `auth/owner.json`（例如 TOTP 步長、Passkey 計數器），就可能被覆蓋，所以必須有維護窗口。

### 2. 準備憑證

在部署者的機器上以有 R2 權限的帳號登入 wrangler：

```bash
npx wrangler login
```

### 3. 執行

```bash
node scripts/reset-owner-password.mjs --bucket pocket-chest --backup ./owner-backup.json
```

- 新密碼以**隱藏輸入**讀取，或用 `--password-stdin` 從管道讀入。密碼不會出現在命令列參數或 Shell 歷史中。
- 新密碼至少 16 字元。
- `--backup` 指定的檔案（權限 `0600`）保存恢復前的 Owner 紀錄，**包含舊的密碼雜湊**。確認完成後請自行妥善保管或刪除。

腳本依序執行：讀取並驗證 Owner 紀錄 → 寫入備份 → 計算新雜湊（新 Salt）→ 再次讀取比對是否仍與第一次相同 → 寫入 → 讀回並以新密碼驗證。任何一步失敗都會停止，且不會留下半寫入的狀態。

### 4. 驗證與收尾

- 腳本成功後會顯示新的 `authVersion`。所有先前的 Owner Session 已失效，需要重新登入。
- 用新密碼登入一次，確認可用。
- 如方法設定需要恢復（例如重新啟用 Password），在登入後到 Security Settings 操作。
- 恢復 `/upload/` 的服務。
- 刪除或妥善保管 `owner-backup.json`。

## 失敗時

| 情況 | 結果 | 處理 |
| --- | --- | --- |
| 找不到 Owner 紀錄 | 不寫入 | 此工具只恢復既有 Owner。若 `auth/bootstrap-marker` 存在但沒有 Owner，請改用下方「首次設定被中斷」。若兩者都不存在，請用 Bootstrap 正常初始化。 |
| 紀錄不是合法 JSON 或欄位不認識 | 不寫入 | 先從 R2 的版本記錄或備份還原，再試。 |
| 讀取兩次之間紀錄改變 | 不寫入，提示重試 | 確認登入入口已暫停後再執行。 |
| 寫入後驗證失敗 | 提示立即以備份還原 | 用 wrangler 將 `owner-backup.json` 寫回 `auth/owner.json`。 |

## 不屬於本工具的事

- 不修改 Cloudflare 帳號設定，不建立或刪除 R2 Bucket。
- 不自動重新啟用已停用的方式以外的設定（TOTP、Passkey 維持原狀）。
- 不提供「忘記密碼」的公開 HTTP API。

## 測試

- 核心邏輯（讀取、驗證、備份、比對、寫入、讀回驗證、競爭中止、損壞紀錄拒絕）由 `test/recovery-cli.spec.ts` 以模擬儲存層驗證，並以 Worker 的實際密碼驗證器核對新雜湊。
- 正式環境**不得**自動執行會寫入 Owner 紀錄的測試。完整人工演練請在隔離的 R2 Bucket 進行。

## 首次設定被中斷（有 marker、沒有 Owner）

Worker 會在首次設定時先計算密碼 hash，再領取 `auth/bootstrap-marker`，最後寫入 `auth/owner.json`。若 hash 失敗（例如 Free 計畫 CPU 超額），不會留下 marker，可直接重試。若 marker 已寫入但 Owner 寫入失敗，網站會顯示需要離線恢復，此時請用部署者專用工具建立首個 Owner：

```bash
node scripts/recover-bootstrap.mjs --bucket pocket-chest
# 或從標準輸入讀取密碼：  --password-stdin
```

- 只在「marker 存在且 Owner 不存在」時才會寫入；Owner 已存在則拒絕（請改用上面的密碼恢復）。
- 密碼至少 16 字元，在本機計算 hash，不經過 Worker，因此不受 Worker CPU 限制。
- 寫入後會重新讀取並驗證密碼；寫入前會再確認一次 Owner 仍不存在。
- **不會**刪除 marker，也**沒有**任何匿名 HTTP 重新初始化入口。同樣需要維護窗口（wrangler 無條件寫入）。
