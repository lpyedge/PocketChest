# 恢復（Owner）

本文件說明在 Owner 登入出問題時能做什麼、不能做什麼。

## 先說結論：不能離線重設密碼

Owner 密碼以 `HMAC-SHA256-KEYED-V1` 儲存：一個隨機 Salt，加上由 Worker 的根密鑰（`JWT_SECRET`）衍生出來的專用金鑰。Cloudflare 不會把 Worker Secret 的值讀回給任何人，所以**只握有 R2 存取權的工具，無法寫出 Worker 會接受的密碼紀錄**。

因此：

- `node scripts/reset-owner-password.mjs` **只會說明這件事並以錯誤結束**；它不讀、也不寫 R2。
- 這是刻意的，不是缺漏：我們不用假的成功回報，也不新增公開的「忘記密碼」入口或永久後門。`ADMIN_BOOTSTRAP_PASSWORD` 只用於首次初始化，不能用來恢復。
- 不需要、也不應該備份或貼出 `JWT_SECRET` 來換取離線重設功能。

## 日常做法：登入後改密碼

已登入的 Owner 在 **Security settings → Change password** 修改密碼（需要最近一次重新驗證）。所有其他登入中的 Session 會失效。

網站上有三種**彼此獨立**的登入方式：密碼、驗證器（TOTP）、Passkey。任何一種單獨就能登入（驗證器**不是**第二因素）。只要還有一種可用，就可以登入並在安全設定裡處理其餘的。建議在密碼之外再綁定一種方式，作為備援。

## 所有登入方式都不可用時

目前沒有安全的離線重設路徑。可行的做法，由部署者自行評估：

1. 確認不是暫時問題：Passkey 是否在原本的網域上、驗證器的時間是否正確、是否被登入鎖定（等鎖定時間結束）。
2. 若 Owner 紀錄損毀或確定無法恢復，而你**接受清空 Owner**：部署者可用自己的 Cloudflare 憑證刪除 `auth/owner.json` 與 `auth/bootstrap-marker`，並確認 `BOOTSTRAP_ENABLED` 與 `ADMIN_BOOTSTRAP_PASSWORD` 已就位，再用首次設定流程建立新的 Owner。這會讓所有 Owner Session 與所有已綁定的驗證器、Passkey 失效，但不會動 `codes/`、`sessions/` 與檔案資料。這是破壞性操作，請先備份 `auth/owner.json`，並在維護窗口進行。
3. 若是 `JWT_SECRET` 被更換或遺失：密碼與驗證器都無法再驗證，處理方式同第 2 點；已簽發的上傳／下載令牌也會失效。

## 首次設定被中斷（有 marker、沒有 Owner）

Worker 在首次設定時先計算密碼 hash，再領取 `auth/bootstrap-marker`，最後寫入 `auth/owner.json`。若 marker 已寫入但 Owner 寫入失敗，網站會顯示需要離線恢復。此時用部署者專用工具**只移除 marker**，讓首次設定能再執行一次：

```bash
npx wrangler login
node scripts/recover-bootstrap.mjs --bucket pocket-chest
```

- 只在「marker 存在且 Owner 不存在」時才會動作；Owner 已存在則拒絕，marker 保持不變。
- 工具**不建立 Owner、不需要密碼**。移除後，首次設定仍須提供部署設定的 `ADMIN_BOOTSTRAP_PASSWORD`。
- 沒有任何匿名 HTTP 重新初始化入口。`wrangler r2 object delete` 不是條件刪除，所以請在維護窗口進行，暫停對外的登入流程。
- 不要手動刪除 `auth/bootstrap-marker` 以外的情況下重開設定；Owner 已存在時絕對不要刪除 marker。

## 不屬於本文件的事

- 不修改 Cloudflare 帳號設定，不建立或刪除 R2 Bucket。
- 不提供「忘記密碼」的公開 HTTP API。

## 測試

- `test/recovery-cli.spec.ts`：離線重設會被拒絕，且不讀寫任何儲存、既有 Owner 與密碼完全不變。
- `test/bootstrap-recovery.spec.ts`：中斷的首次設定只清除 marker，Owner 已存在、marker 不存在、清除期間出現 Owner 等狀態都被拒絕或回報。
- 正式環境**不得**自動執行會改動 Owner 紀錄的測試；完整人工演練請在隔離的 R2 Bucket 進行。
