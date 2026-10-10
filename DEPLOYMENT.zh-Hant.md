# PocketChest — 部署指南

[English](DEPLOYMENT.md) | [繁體中文](DEPLOYMENT.zh-Hant.md) | [日本語](DEPLOYMENT.ja.md) | [PocketChest](README.zh-Hant.md)

> 私有化檔案與文字分享。只需一個 Cloudflare Worker、一個 R2 Bucket，不依賴資料庫。

## 1. 一鍵部署（建議）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lpyedge/PocketChest)

1. 點擊按鈕，登入 Cloudflare 並授權連接 GitHub。它會把本倉庫複製到你的帳號，並依 `wrangler.jsonc` 建立 Worker、R2 Bucket（`R2_STORAGE`）、限流綁定與每小時的 Cron。
2. 表單只會問**一個** Secret：`ADMIN_BOOTSTRAP_PASSWORD`，也就是你的 PocketChest **Owner 密碼**（至少 16 個字元，不可是範例值）。在這裡設定一次即可，沒有其他要產生、複製或備份的東西。
3. 確認 **Build** 是 `npm run build`、**Deploy** 是 `npm run deploy`，然後部署。`npm run deploy` 第一次會自行產生簽章用的 `JWT_SECRET`，之後一直沿用。若把 Deploy 指令改成單純的 `npx wrangler deploy`，網站會回應 `SERVER_MISCONFIGURED`，改回 `npm run deploy` 即可。
4. 開啟 `https://<your-worker>.<your-subdomain>.workers.dev/upload/`。網站會用你設定的密碼建立 Owner，並顯示**一般登入**：用同一個密碼登入即可，不會再要求你為了「設定」而輸入第二次。
5. 之後可選：在**安全設定**修改密碼，或加入驗證器 App、Passkey。請在註冊 Passkey **之前**決定正式主機名稱並設定 `PASSKEY_RP_ID`（[營運](docs/OPERATIONS.md#passkey-domain)）。

**升級**不需要輸入任何東西：推送新程式碼，讓同一個建置流程跑一次。`npm run deploy` 判斷安裝已完成，只部署程式碼；你的密碼、Secrets、分享與設定都不會被動到。升級時不要再按一次 Deploy 按鈕。

**部署成功不等於已通過驗收。**請依[第 6 節](#6-驗證安裝)，在你自己的 Cloudflare 方案上檢查 R2 並發、Cron、限流與大檔。

## 2. 手動部署

**你需要** Cloudflare 帳號、Node.js 22.12 以上（建議 24）與 npm。PocketChest 只適用於全新安裝，不提供從舊資料庫版本的遷移。

```bash
npm ci
npx wrangler login
npx wrangler r2 bucket create pocket-chest
# 使用不同的 Bucket 名稱？請同步修改 wrangler.jsonc 的 bucket_name。
npm run deploy
```

`npm run deploy` 會**只問一次** Owner 密碼（隱藏輸入，至少 16 個字元），自行產生簽章 Secret 並部署。在腳本或 CI 中，請改用環境變數 `ADMIN_BOOTSTRAP_PASSWORD`。之後開啟 `/upload/`，用該密碼登入。

再次執行 `npm run deploy` 就是升級：不問任何事，也不改任何 Secret。它在變更任何東西之前，會先查詢 Cloudflare 對 `wrangler.jsonc` 中 Worker 與 Bucket 的說法；只要結果不明確就**拒絕**（不做任何變更），例如：Owner 已存在但 Worker 沒有簽章 Secret（帳號或 Worker 名稱不對），或首次設定被中斷（[離線復原](docs/RECOVERY.md)）。請勿手動刪除 R2 中的初始化標記。

### 用 GitHub Actions 部署

如果你的倉庫是 PocketChest 的副本或 Fork，可以從 **Actions** 分頁執行 `.github/workflows/deploy-manual.yml`（「Deploy (manual)」）來安裝或升級。它只在你手動啟動時執行，先跑測試與 dry-run，再執行與 `npm run deploy` 相同的安裝程式。

1. Settings → Secrets and variables → Actions：新增 `CLOUDFLARE_API_TOKEN`（只限你的帳號，權限為 Workers Scripts: Edit 與 Workers R2 Storage: Edit）與 `CLOUDFLARE_ACCOUNT_ID`。**只有第一次安裝**還需要 `ADMIN_BOOTSTRAP_PASSWORD`：你的 Owner 密碼（至少 16 個字元），請放在倉庫 **Secret**，不要當作執行時的輸入。也可以建立名為 `production` 的 Environment 並設定審核者，讓每次執行都需要批准。
2. Actions → Deploy (manual) → Run workflow。Worker 與 Bucket 就是 `wrangler.jsonc` 中指定的那一組。
3. 開啟 `/upload/`，用該密碼登入。之後再執行就是升級：不需要密碼，也不會改動任何 Secret、Owner 或 Bucket 資料。流程會先查詢 Cloudflare 對該 Worker 與 Bucket 的說法，結果不明確就停止、不做任何變更。

每個安裝請只用這一種，**或是** Workers Builds／`npm run deploy`，不要兩者並用。

## 3. Secrets 與設定

| 名稱 | 類型 | 說明 |
| --- | --- | --- |
| `ADMIN_BOOTSTRAP_PASSWORD` | 你只設定一次的 Worker Secret | 你的 Owner 密碼，至少 16 個字元。網站第一次使用時用它建立 Owner；Owner 建立後不再使用，也不需要刪除。 |
| `JWT_SECRET` | 為你產生的 Worker Secret | 由 `npm run deploy` 產生一次，你不必輸入或備份。用來簽發上傳與下載憑證，也是 Worker 衍生密碼金鑰與驗證器 Seed 金鑰的根。**Owner 建立後絕不能更換：**密碼與驗證器都會無法驗證（部署程序會拒絕這麼做）。 |
| `PASSKEY_RP_ID` | 選用變數 | Passkey 綁定的唯一主機名稱。註冊 Passkey 之前先設定。 |
| `INSTANCE_ID` | 選用變數 | 通常不設定：限流計數用的識別碼會在 Bucket 中建立一次。 |
| `R2_STORAGE` | R2 綁定 | 檔案與所有中繼資料，存放在同一個私有 Bucket。 |
| `AUTH_LIMITER`、`RETRIEVE_LIMITER`、`UPLOAD_LIMITER`、`PART_LIMITER`、`PART_TOTAL_LIMITER`、`DOWNLOAD_LIMITER` | 限流綁定 | 針對登入、取件、上傳、上傳分段與下載的每用戶端限制。不需額外資料庫。 |

沒有驗證器金鑰需要設定：若你設定驗證器 App，Worker 會用由 `JWT_SECRET` 衍生的金鑰保護它的 Seed。本機開發請執行 `npm run setup:local`，它會用全新的隨機值寫出 `.dev.vars`。不要公開 `.dev.vars`，也不要在任何真實環境使用範例值。

## 4. 建置與部署設定

用 GitHub 的 Workers Builds 時，**Build** 設為 `npm run build`，**Deploy** 設為 `npm run deploy`（建置步驟會產生 `dist/`；若只想用 Wrangler 推送程式碼並自行管理 Secrets，改用 `npm run deploy:code`）。`dist/` 資料夾以 Workers Static Assets 提供；Worker 本身只處理 `/api/*`。`/upload/` 出現空白頁或 404，代表部署前沒有建置 `dist/`。每個安裝只用一個部署者：Workers Builds 或你自己的 `npm run deploy`，不要兩者並用。

## 5. 首次使用與日常使用

- 你用自己設定的 Owner 密碼登入。隨時可在**安全設定**中修改（至少 16 個字元）。
- 密碼、驗證器 App、Passkey 是三種**彼此獨立**的登入方式：任何一種單獨就能登入。驗證器代碼**不是**密碼之外的第二因素。請至少設定兩種，以免遺失一台裝置就無法登入。若所有方式都遺失，請見[復原](docs/RECOVERY.md)（密碼無法離線重設）。
- 上傳 Session 從建立起 24 小時結束。分享可設定 1、3、7、14 天或永久；每小時清理會移除已過期的內容。安全設定旁的**分享記錄**可查看目前有效的分享，並延長或撤銷。

## 6. 驗證安裝

- [ ] `/`、`/ja/`、`/en/`、`/upload/`、`/retrieve/` 都能開啟。
- [ ] `/upload/` 顯示一般登入（沒有第二個「設定」步驟），且 Owner 密碼可以登入。
- [ ] 文字與小檔案可以上傳並下載，內容與檔名正確。
- [ ] 你使用的每種登入方式都可用；已關閉的方式無法再登入。
- [ ] 每小時 Cron 無錯誤執行，限流在真實 Worker 上會回應 `429`。
- [ ] 超過 20 MiB 的大檔可以上傳與下載。
- [ ] 設定 `PASSKEY_RP_ID` 之後，Passkey 能在正式網域使用。

完整清單見 [REMOTE_ACCEPTANCE.md](docs/REMOTE_ACCEPTANCE.md)。日誌、清理工作、儲存的 Key、自訂網域與已知限制請見 [docs/OPERATIONS.md](docs/OPERATIONS.md)。

## 7. 疑難排解

| 現象 | 可能原因 |
| --- | --- |
| 所有 `/api/*` 都回應 `SERVER_MISCONFIGURED` | 缺少簽章 Secret：網站是用單純的 `wrangler deploy` 部署的。請執行 `npm run deploy`。 |
| `/upload/` 說沒有有效的初始密碼 | 尚未建立 Owner，且 `ADMIN_BOOTSTRAP_PASSWORD` 從未設定、少於 16 個字元，或仍是範例值。請設定後重新部署。 |
| `/upload/` 說首次設定被中斷 | 有初始化標記但沒有 Owner。請執行 `node scripts/recover-bootstrap.mjs --bucket <名稱>`（見[復原](docs/RECOVERY.md)）。 |
| `npm run deploy` 拒絕執行 | 它會說明原因，且沒有變更任何東西；常見原因見第 2 節。 |
| 設定或使用驗證器時出現 `AUTH_NOT_CONFIGURED` | `JWT_SECRET` 未設定、太短，或與設定驗證器當時的值不同。 |
| `/upload/` 空白頁或 404 | 部署前沒有建置 `dist/`（見第 4 節）。 |
| 儲存錯誤 | R2 Bucket 不存在，或 `wrangler.jsonc` 的 `bucket_name` 與它不符。 |
| Passkey 被 `PASSKEY_DOMAIN_MISMATCH` 拒絕 | 請求來自 `PASSKEY_RP_ID` 以外的主機名稱。 |

## 8. 專案來源與新增功能

本專案 Fork 自 [Hzao/PocketChest](https://github.com/Hzao/PocketChest)。此分支新增單 Worker + R2-only 架構、一鍵部署、Owner 限定上傳、密碼／TOTP／Passkey 三種獨立登入、安全設定、三語介面、分享連結改善、限流與清理強化。這是獨立 Fork，不代表原作者為修改版本背書。
