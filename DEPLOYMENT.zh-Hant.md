# PocketChest — 部署指南

[English](DEPLOYMENT.md) | [繁體中文](DEPLOYMENT.zh-Hant.md) | [日本語](DEPLOYMENT.ja.md) | [PocketChest](README.md)

> 私人、自架的檔案與文字分享。一個 Cloudflare Worker、一個 R2 儲存桶，沒有資料庫。

## 1. 一鍵部署（建議）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lpyedge/PocketChest)

1. 點擊按鈕，登入 Cloudflare，並允許它連接 GitHub。它會把這個儲存庫複製到你的帳號，並依 `wrangler.jsonc` 建立 Worker、R2 儲存桶（`R2_STORAGE`）、限流綁定與每小時的排程。
2. 表單**不需要任何輸入**。你不必選擇或輸入 Owner 密碼，也沒有需要產生的簽章密鑰。
3. 確認 **Build** 是 `npm run build`、**Deploy** 是 `npm run deploy:installer`，然後部署。建置只跑一次；安裝程式會自己產生簽章密鑰（`JWT_SECRET`），缺少時建立 R2 儲存桶，確認儲存桶是私人的，然後啟動首次設定。這裡請用 `npm run deploy:installer`，不要直接用 `npx wrangler deploy`，否則網站會回應 `SERVER_MISCONFIGURED`。
4. 部署記錄的最後會列出網址、儲存桶、物件鍵，以及下面的步驟。開啟 `https://<你的-worker>.<你的子網域>.workers.dev/upload/`。網站會在第一次使用時產生你的 **Owner 密碼**，**網站本身從不顯示它**。請從儲存桶取得：
   1. Cloudflare 儀表板 → **R2** → 開啟記錄中列出的儲存桶。
   2. **Objects** → 開啟 `auth/initial-owner-password.txt` → **Download**。
   3. 用這組密碼登入網站。
5. 立即在 **安全設定** 中更改密碼（至少 8 個字元，不要使用容易猜到或重複的字元）。更改成功後，儲存的副本會自動刪除；若更改失敗，檔案會保留。
6. 之後可選擇加入驗證器應用程式或通行金鑰。在註冊通行金鑰**之前**，先確定最終的網域並設定 `PASSKEY_RP_ID`（[操作說明](docs/OPERATIONS.md#passkey-domain)）。

**升級**不需要任何輸入：推送新程式碼並讓同一個建置執行即可。`npm run deploy:installer` 會判斷安裝已完成，只部署程式碼；你的密碼、密鑰、分享與設定都不會被變動。升級時不要再按一次 Deploy 按鈕。

**部署成功不等於驗收通過。** 請在你自己的 Cloudflare 方案上檢查 R2 並發、排程、限流與大檔案，清單見[第 6 節](#6-檢查安裝結果)。

## 2. 手動部署

**你需要**一個 Cloudflare 帳號、Node.js 22.12 以上（建議 24）與 npm。PocketChest 只適用於新安裝，沒有舊資料庫版本的遷移。

```bash
npm ci
npx wrangler login
npm run deploy
```

`npm run deploy` 會建置一次，然後執行安裝程式。它不需要任何輸入。它會先向 Cloudflare 查詢 `wrangler.jsonc` 中指定的 Worker 與儲存桶，答案不明確時會**拒絕執行**（不改變任何東西）。首次安裝時，它會在儲存桶缺少時建立它、產生簽章密鑰、確認儲存桶是私人的（r2.dev 關閉、沒有自訂網域）、啟動首次設定，然後確認網站已就緒。它會印出與第 1 節相同的取得密碼步驟。要改用其他儲存桶名稱？請先修改 `wrangler.jsonc` 的 `bucket_name`。

再次執行 `npm run deploy` 就是升級：不會改變任何密鑰、Owner 或儲存桶資料。若 Owner 已存在但 Worker 沒有簽章密鑰（帳號或 Worker 名稱錯誤），或首次設定中斷，安裝程式會拒絕並說明原因（[離線復原](docs/RECOVERY.md)）。切勿手動移除 R2 中的設定標記。

### 使用 GitHub Actions 部署

若你的儲存庫是 PocketChest 的複製或分支，`.github/workflows/deploy-manual.yml`（「Deploy (manual)」）可在 **Actions** 頁面安裝或升級。它只在你手動啟動時執行，會先跑測試與試運行，然後執行與 `npm run deploy` 相同的安裝程式。

1. Settings → Secrets and variables → Actions：新增 `CLOUDFLARE_API_TOKEN`（Workers Scripts: Edit 與 Workers R2 Storage: Edit，只限你的帳號）與 `CLOUDFLARE_ACCOUNT_ID`。不需要新增 Owner 密碼。可選擇建立名為 `production` 的 Environment 並設定必要審核人，讓每次執行都需核准。
2. Actions → Deploy (manual) → Run workflow。Worker 與儲存桶是 `wrangler.jsonc` 中指定的那一組。
3. 工作記錄的最後會列出網址、儲存桶與第一組密碼的物件鍵。請依第 1 節從儲存桶取得密碼。之後的執行都是升級，不會改變任何密鑰、Owner 或儲存桶資料。

同一個安裝只能選用**一種**部署方式：這個工作流程，或 Workers Builds / 你自己的 `npm run deploy`，不要兩者並用。

## 3. 密鑰、物件與設定

| 名稱 | 類型 | 說明 |
| --- | --- | --- |
| `auth/initial-owner-password.txt` | Worker 產生的私人 R2 物件 | 你的第一組 Owner 密碼，只產生一次（32 個隨機位元組）。在 R2 儀表板讀取，更改密碼後檔案會被移除。網站、API 與建置記錄都不會顯示它。 |
| `JWT_SECRET` | 系統為你產生的 Worker 密鑰 | 由安裝程式產生一次；你不需要輸入或備份。用來簽發上傳與下載權杖，也是 Worker 推導密碼金鑰與驗證器種子金鑰的根。**Owner 建立後絕對不要更換**：密碼與驗證器都會失效（部署會拒絕這樣做）。 |
| `SETUP_ARMED` | 安裝程式設定的 Worker 密鑰 | 只有在證實儲存桶是私人的之後才會開啟，讓 Worker 能產生第一組密碼。請勿手動設定。 |
| `ADMIN_BOOTSTRAP_PASSWORD` | 已不再使用 | Worker 不會讀取它，安裝程式也不會詢問或設定它。以舊表單建立的安裝仍可運作：它們的 Owner 已存在，升級也不會移除這個密鑰。 |
| `PASSKEY_RP_ID` | 可選變數 | 通行金鑰綁定的唯一網域。註冊通行金鑰前設定。 |
| `INSTANCE_ID` | 可選變數 | 通常不設定：限流計數器的識別碼會在儲存桶中建立一次。 |
| `R2_STORAGE` | R2 綁定 | 所有檔案與中繼資料，都在同一個私人儲存桶中。 |
| `AUTH_LIMITER`、`RETRIEVE_LIMITER`、`UPLOAD_LIMITER`、`PART_LIMITER`、`PART_TOTAL_LIMITER`、`DOWNLOAD_LIMITER` | 限流綁定 | 依用戶端限制登入、取回、上傳、分片與下載。不需要額外資料庫。 |

儲存桶必須保持私人：r2.dev 存取關閉，且沒有自訂網域。安裝程式會在啟動首次設定前檢查這一點。Worker 自己的 `workers.dev` 網址與儲存桶是分開的，你開啟網站就是用它。

沒有需要設定的驗證器金鑰：如果你設定驗證器應用程式，Worker 會用由 `JWT_SECRET` 推導出的金鑰保護它的種子。本機開發可執行 `npm run setup:local`，它會寫入 `.dev.vars` 並產生隨機值。切勿公開 `.dev.vars`，也不要在任何真實環境使用範例值。

## 4. 建置與部署設定

使用 GitHub 的 Workers Builds 時，把 **Build** 設為 `npm run build`，**Deploy** 設為 `npm run deploy:installer`。建置步驟會建置 `dist/`；部署步驟執行安裝程式，由它部署。`npm run deploy` 是本機用的一行版本，會依序執行這兩個步驟；`npm run deploy:code` 只用 Wrangler 推送程式碼。`dist/` 資料夾以 Workers Static Assets 提供；Worker 本身只處理 `/api/*`。若 `/upload/` 空白或 404，代表部署前沒有建置 `dist/`。每個安裝只能用一種部署方式：Workers Builds 或你自己的 `npm run deploy`。

## 5. 首次使用與日常使用

- 以 Owner 密碼登入。第一組密碼在第 1 節所述的儲存桶物件中；請立即在 **安全設定** 中更改（至少 8 個字元）。
- 密碼、驗證器應用程式與通行金鑰是三種**彼此獨立**的登入方式，任何一種都能單獨登入。驗證器代碼**不是**密碼之外的第二因素。請至少設定兩種，避免一台裝置遺失就無法登入。若所有方式都遺失，請見[復原說明](docs/RECOVERY.md)（密碼無法離線重設）。
- 上傳工作階段於開始後 24 小時結束。分享可保留 1、3、7 或 14 天，或永久；每小時的清理會移除過期的分享。**分享紀錄**（位於安全設定旁）列出你的有效分享，並可延長或撤銷。

## 6. 檢查安裝結果

- [ ] `/`、`/ja/`、`/en/`、`/upload/` 與 `/retrieve/` 都能載入。
- [ ] `/upload/` 顯示一般登入畫面（沒有第二個「設定」步驟）。儲存桶中的第一組密碼可以登入；更改後，新密碼可以登入。
- [ ] 儲存桶顯示 r2.dev 已關閉，且沒有自訂網域。
- [ ] 文字與小檔案都能上傳，下載的內容與檔名正確。
- [ ] 你使用的每種登入方式都能登入，已關閉的方式無法登入。
- [ ] 每小時的排程沒有錯誤，真實 Worker 上的限流會回應 `429`。
- [ ] 大檔案（超過 20 MiB）可以上傳與下載。
- [ ] 設定 `PASSKEY_RP_ID` 後，通行金鑰在最終網域上可用。

完整清單見 [REMOTE_ACCEPTANCE.md](docs/REMOTE_ACCEPTANCE.md)。記錄、清理工作、儲存的鍵、自訂網域與已知限制見 [docs/OPERATIONS.md](docs/OPERATIONS.md)。

## 7. 疑難排解

| 現象 | 可能原因 |
| --- | --- |
| 所有 `/api/*` 都回應 `SERVER_MISCONFIGURED` | 缺少簽章密鑰：網站是用一般 `wrangler deploy` 部署的。請執行 `npm run deploy`（或安裝程式的部署指令）。 |
| `/upload/` 表示尚不能設定 | 首次設定尚未啟動：安裝程式還沒完成。請再執行一次部署，拒絕時會說明原因。 |
| 部署以 `bucket-not-private` 拒絕 | r2.dev 存取開啟，或儲存桶附加了自訂網域。請在 R2 儀表板關閉兩者後再部署。 |
| `/upload/` 表示首次設定中斷 | 存在設定標記但沒有 Owner。執行 `node scripts/recover-bootstrap.mjs --bucket <名稱>`（見[復原說明](docs/RECOVERY.md)）。 |
| 部署表示「尚未就緒」 | 記錄會列出缺少的項目（登入未就緒、Owner 或第一組密碼物件不在儲存桶中）。修正後再部署。 |
| `npm run deploy` 拒絕執行 | 它會說明原因且沒有改動任何東西；常見原因見第 2 節。 |
| 驗證器設定或登入出現 `AUTH_NOT_CONFIGURED` | `JWT_SECRET` 缺少、太短，或不是設定驗證器時使用的值。 |
| `/upload/` 空白或 404 | 部署前沒有建置 `dist/`（見第 4 節）。 |
| 儲存錯誤 | R2 儲存桶不存在，或 `wrangler.jsonc` 的 `bucket_name` 與它不符。 |
| 通行金鑰以 `PASSKEY_DOMAIN_MISMATCH` 拒絕 | 請求來自與 `PASSKEY_RP_ID` 不同的主機名稱。 |

## 8. 專案來源與增強

本專案分支自 [Hzao/PocketChest](https://github.com/Hzao/PocketChest)。此分支新增單一 Worker + 僅 R2 的架構、一鍵部署、僅擁有者可上傳、密碼 / TOTP / 通行金鑰各自獨立的登入、安全設定、在地化介面、更好的分享連結、限流與清理。這是獨立的分支，不代表上游作者的認可。
