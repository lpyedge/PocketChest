# PocketChest — 部署指南

[English](DEPLOYMENT.md) | [繁體中文](DEPLOYMENT.zh-Hant.md) | [日本語](DEPLOYMENT.ja.md) | [PocketChest](README.zh-Hant.md)

> 私有化檔案與文字分享。只需一個 Cloudflare Worker、一個 R2 Bucket，不依賴資料庫。

## 1. 一鍵部署（建議）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lpyedge/PocketChest)

1. 點擊按鈕，登入 Cloudflare 並授權連接 GitHub。它會把本倉庫複製到你的帳號，並依 `wrangler.jsonc` 建立 Worker、R2 Bucket（`R2_STORAGE`）、限流綁定與每小時的 Cron。
2. Secret 表單會列出 `JWT_SECRET`、`AUTH_ENCRYPTION_KEY`、`ADMIN_BOOTSTRAP_PASSWORD`，並預先填入 `.dev.vars.example` 的佔位值。**請逐一換成你自己產生的隨機值**（指令見[第 2 節](#2-手動部署)）。保留佔位值的部署會被拒絕：API 回應 `SERVER_MISCONFIGURED`，也無法用佔位密碼建立 Owner。
3. 確認 **Build** 是 `npm run build`、**Deploy** 是 `npx wrangler deploy`，然後部署。
4. 開啟 `https://<你的 worker>.<你的子網域>.workers.dev/upload/`。在還沒有 Owner 且初始化模式開啟時，頁面會要求輸入初始密碼。輸入 `ADMIN_BOOTSTRAP_PASSWORD` 建立 Owner；在你更改之前，它就是 Owner 的密碼。
5. **立即關閉初始化。**刪除 `ADMIN_BOOTSTRAP_PASSWORD` Secret（Worker → Settings → Variables and Secrets）：沒有它，初始化就無法執行。接著在按鈕替你建立的 GitHub 倉庫中，把 `wrangler.jsonc` 的 `BOOTSTRAP_ENABLED` 改成 `"false"` 並 commit，讓之後的建置維持關閉。只在 Dashboard 修改會被下次建置覆蓋。
6. 開啟**安全設定**，設定你自己的密碼，再加入驗證器 App 或 Passkey。**註冊 Passkey 之前**先決定正式網域並設定 `PASSKEY_RP_ID`（[維運說明](docs/OPERATIONS.md#passkey-domain)）。

**部署成功不等於已通過驗收。**請依[第 6 節](#6-驗證安裝)，在你自己的 Cloudflare 方案上檢查 PBKDF2 的 CPU 用量、R2 並發、Cron、限流與大檔。不可為了適應 Free 方案而削弱密碼雜湊。

## 2. 手動部署

**需要：**Cloudflare 帳號、Node.js 22.12 以上（建議 24）、npm，以及一個空的 R2 Bucket。PocketChest 只支援全新安裝，不提供從舊版資料庫遷移。

```bash
npm ci
npx wrangler login
npx wrangler r2 bucket create pocket-chest
# 使用不同的 Bucket 名稱？請同步修改 wrangler.jsonc 的 bucket_name。
```

產生三個**互不相同**的值，並妥善私下保存：

```bash
openssl rand -base64 48   # JWT_SECRET
openssl rand -base64 32   # AUTH_ENCRYPTION_KEY：解碼後必須剛好 32 bytes
openssl rand -base64 24   # ADMIN_BOOTSTRAP_PASSWORD：至少 16 個字元
# 沒有 openssl：node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

```bash
npx wrangler secret put JWT_SECRET
npx wrangler secret put AUTH_ENCRYPTION_KEY
npx wrangler secret put ADMIN_BOOTSTRAP_PASSWORD
```

倉庫中的 `BOOTSTRAP_ENABLED` 預設為 `"true"`，供第一次安裝使用。建置並部署：

```bash
npm run build
npx wrangler deploy        # 或：npm run deploy（會先建置）
```

開啟 `/upload/` 建立 Owner，並在公開使用前**關閉初始化**：

```bash
npx wrangler secret delete ADMIN_BOOTSTRAP_PASSWORD
# 把 wrangler.jsonc 的 BOOTSTRAP_ENABLED 改成 "false"，然後：
npx wrangler deploy
```

不要為了重新開放初始化而刪除 R2 中的初始化標記。若初始化被中斷，請使用[離線復原](docs/RECOVERY.md)。

## 3. Secrets 與設定

| 名稱 | 類型 | 說明 |
| --- | --- | --- |
| `JWT_SECRET` | Worker Secret | 簽發上傳與下載憑證。至少 24 個字元、隨機，絕不能是範例值。 |
| `AUTH_ENCRYPTION_KEY` | Worker Secret | 剛好 32 個隨機 bytes 的 Base64；用來加密驗證器 Seed。請備份：遺失後必須重新設定驗證器。 |
| `ADMIN_BOOTSTRAP_PASSWORD` | 一次性 Worker Secret | 至少 16 個字元。用來建立 Owner，**完成後請刪除**。 |
| `BOOTSTRAP_ENABLED` | `wrangler.jsonc` 變數 | 只有第一次安裝時為 `"true"`；Owner 建立後改為 `"false"`。 |
| `PASSKEY_RP_ID` | 選用變數 | Passkey 綁定的唯一主機名稱。註冊 Passkey 之前先設定。 |
| `R2_STORAGE` | R2 綁定 | 檔案與所有中繼資料，存放在同一個私有 Bucket。 |
| `AUTH_LIMITER`、`RETRIEVE_LIMITER`、`UPLOAD_LIMITER`、`PART_LIMITER`、`PART_TOTAL_LIMITER`、`DOWNLOAD_LIMITER` | 限流綁定 | 針對登入、取件、上傳、上傳分段與下載的每用戶端限制。不需額外資料庫。 |

本機開發請執行 `npm run setup:local`，它會用全新的隨機值寫出 `.dev.vars`。不要公開 `.dev.vars`，也不要在任何真實環境使用範例值。

## 4. 建置與部署設定

用 GitHub 的 Workers Builds 時，**Build** 設為 `npm run build`，**Deploy** 設為 `npx wrangler deploy`。不要在那裡使用 `npm run deploy`，它會再建置一次。`dist/` 資料夾以 Workers Static Assets 提供；Worker 本身只處理 `/api/*`。`/upload/` 出現空白頁或 404，代表部署前沒有建置 `dist/`。

## 5. 首次設定與日常使用

- 初始密碼會成為 Owner 的密碼。請在**安全設定**中改掉它（至少 16 個字元）。
- 密碼、驗證器 App、Passkey 可各自獨立登入。請至少設定兩種，以免遺失一台裝置就無法登入。若所有方式都遺失，請見[離線復原](docs/RECOVERY.md)。
- 上傳 Session 從建立起 24 小時結束。分享可設定 1、3、7、14 天或永久；每小時清理會移除已過期的內容。

## 6. 驗證安裝

- [ ] `/`、`/ja/`、`/en/`、`/upload/`、`/retrieve/` 都能開啟。
- [ ] Owner 只建立了一次，`ADMIN_BOOTSTRAP_PASSWORD` 已刪除，已部署的設定中 `BOOTSTRAP_ENABLED` 為 `"false"`。
- [ ] 文字與小檔案可以上傳並下載，內容與檔名正確。
- [ ] 你使用的每種登入方式都可用；已關閉的方式無法再登入。
- [ ] 密碼登入在你的 Workers 方案 CPU 額度內可完成（請實測；見[已知限制](docs/OPERATIONS.md#known-limits)）。
- [ ] 每小時 Cron 無錯誤執行，限流在真實 Worker 上會回應 `429`。
- [ ] 超過 20 MiB 的大檔可以上傳與下載。
- [ ] 設定 `PASSKEY_RP_ID` 之後，Passkey 能在正式網域使用。

完整清單見 [REMOTE_ACCEPTANCE.md](docs/REMOTE_ACCEPTANCE.md)。日誌、清理工作、儲存的 Key、自訂網域與已知限制請見 [docs/OPERATIONS.md](docs/OPERATIONS.md)。

## 7. 疑難排解

| 現象 | 可能原因 |
| --- | --- |
| 所有 `/api/*` 都回應 `SERVER_MISCONFIGURED` | `JWT_SECRET` 未設定、太短，或仍是範例值。 |
| 初始化回應 `BOOTSTRAP_MISCONFIGURED` | `ADMIN_BOOTSTRAP_PASSWORD` 少於 16 個字元，或仍是範例值。 |
| 初始化回應 `BOOTSTRAP_DISABLED` | `BOOTSTRAP_ENABLED` 不是 `"true"`，或沒有設定該 Secret。 |
| 設定驗證器時出現 `AUTH_NOT_CONFIGURED` | `AUTH_ENCRYPTION_KEY` 未設定，或不是 32 bytes 的 Base64。 |
| `/upload/` 空白頁或 404 | 部署前沒有建置 `dist/`（見第 4 節）。 |
| 儲存錯誤 | R2 Bucket 不存在，或 `wrangler.jsonc` 的 `bucket_name` 與它不符。 |
| Passkey 被 `PASSKEY_DOMAIN_MISMATCH` 拒絕 | 請求來自 `PASSKEY_RP_ID` 以外的主機名稱。 |

## 8. 專案來源與新增功能

本專案 Fork 自 [Hzao/PocketChest](https://github.com/Hzao/PocketChest)。此分支新增單 Worker + R2-only 架構、一鍵部署、Owner 限定上傳、密碼／TOTP／Passkey 三種獨立登入、安全設定、三語介面、分享連結改善、限流與清理強化。這是獨立 Fork，不代表原作者為修改版本背書。
