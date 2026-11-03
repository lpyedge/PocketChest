# PocketChest

[English](README.md) | [繁體中文](README.zh-Hant.md) | [日本語](README.ja.md)

> 私有化檔案與文字分享。只需一個 Cloudflare Worker、一個 R2 Bucket，不依賴資料庫。

## 🚀 快速部署

[![Deploy with TapDeploy](https://raw.githubusercontent.com/lpyedge/TapDeploy/master/src/web/public/button.svg)](https://tapdeploy.27070.com/?config=https%3A%2F%2Fraw.githubusercontent.com%2Flpyedge%2FPocketChest%2Fmaster%2Fscripts%2Ftapdeploy.config.json)
[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lpyedge/PocketChest)

**推薦使用 TapDeploy**。它直接在瀏覽器裡把最新的預先建置版本安裝到你自己的 Cloudflare 帳號，你這邊不需要建置，升級也只要再按一次同一個按鈕。如果你想要一份自己的程式碼來修改，再選 **Deploy to Cloudflare**。

| | TapDeploy（推薦） | Deploy to Cloudflare |
| --- | --- | --- |
| 需要 | Cloudflare 帳號 | Cloudflare 帳號與 GitHub 帳號 |
| 會做什麼 | 把最新 release 安裝成一個 Worker 和它的 R2 Bucket。寫入任何東西之前，你會先看到所有變更。 | 把本倉庫複製到你的 GitHub 帳號，用 Workers Builds 建置，並建立 R2 Bucket。 |
| Owner 密碼 | 可以自己輸入（至少 8 個字元，須同時包含字母與數字），也可以留空，之後到 R2 Bucket 讀取產生好的密碼再更改。 | 首次設定時產生，只私下保存在你的 R2 Bucket：在那裡讀取一次，之後再更改。 |
| 升級 | 再按一次按鈕，選 **Upgrade existing**。不需要輸入任何東西，密碼、分享、Owner 與 Bucket 都會保留。 | 把 [Update from upstream](docs/OPERATIONS.md#update-from-upstream) 開出的 pull request 合併到你的副本，同一套建置會部署它，不需要輸入任何東西。 |
| 適合 | 直接使用 PocketChest | 修改程式碼 |

已經用 **Deploy to Cloudflare** 部署過了？TapDeploy 也能升級那個 Worker。先斷開它連接的 Git 倉庫（Worker → **Settings** → **Build**），否則下一次建置又會把版本換回去；然後在審查頁勾選 **Take over**。

[完整部署指南](DEPLOYMENT.zh-Hant.md) · [手動部署](DEPLOYMENT.zh-Hant.md#2-手動部署)

TapDeploy 按鈕讀取的是最新 release 上的 ZIP；每次推送到 `master` 且通過 CI，就會自動發佈新的 release。**尚未在真實 Cloudflare 帳號上驗證**：Deploy to Cloudflare 的一鍵流程（按鈕預填 `npm run deploy`、Secret 表單、Workers Builds）目前只用模擬的 Cloudflare 回應在本機測過；按鈕部署成功並不等於已通過正式環境驗收。

## ✨ 主要功能

- 密碼、驗證器 App（TOTP）、Passkey 是三種獨立的登入方式，任何一種就足夠（驗證器代碼**不是**密碼之後的第二步）；至少保持一種啟用。驗證器與 Passkey 都是選用的，登入後才設定，第一個確認後立即可用。
- 只有 Owner 可以上傳；取件者憑取件碼或 `#CODE` 直接連結取件，無須登入。**分享記錄**可列出有效的分享，並讓 Owner 延長或撤銷。
- 文字與 Multipart 大檔；分享期限可選 1／3／7／14／30 天、3 個月（90 天）或永久；每小時自動清理。
- 繁體中文、日文、英文，並有各語言的靜態首頁。
- 單一 Worker + Workers Static Assets + R2；不使用 D1、KV 或獨立前端服務。

## 📦 使用流程

1. 前往 `/upload/`，用任一已啟用的方式登入。
2. 加入檔案或文字，選擇分享期限，完成分享。
3. 複製 `/retrieve/#CODE` 直接連結，或分開複製取件頁網址與取件碼。
4. 取件者無須帳號即可取件。

## 🖼️ 介面截圖

| | |
|:--:|:--:|
| <img src="docs/screenshots/home-zh-Hant.png" alt="首頁" width="420"><br>首頁 | <img src="docs/screenshots/login-zh-Hant.png" alt="Owner 登入" width="420"><br>Owner 登入 |
| <img src="docs/screenshots/upload-zh-Hant.png" alt="上傳" width="420"><br>上傳 | <img src="docs/screenshots/share-result-zh-Hant.png" alt="分享結果" width="420"><br>分享結果 |
| <img src="docs/screenshots/retrieve-zh-Hant.png" alt="取件" width="420"><br>取件 | <img src="docs/screenshots/share-records-zh-Hant.png" alt="分享記錄" width="420"><br>分享記錄 |
| <img src="docs/screenshots/security-settings-zh-Hant.png" alt="安全設定" width="420"><br>安全設定 | <img src="docs/screenshots/upload-zh-Hant-mobile.png" alt="上傳 (mobile)" width="200"> <img src="docs/screenshots/share-result-zh-Hant-mobile.png" alt="分享結果 (mobile)" width="200"> <img src="docs/screenshots/share-records-zh-Hant-mobile.png" alt="分享記錄 (mobile)" width="200"> <img src="docs/screenshots/retrieve-zh-Hant-mobile.png" alt="取件 (mobile)" width="200"> |


截圖由 `npm run screenshots` 從目前的建置擷取（見 [docs/SCREENSHOTS.md](docs/SCREENSHOTS.md)）；畫面中的取件碼只是用完即丟的測試資料。

## 🛡️ 安全說明與目前限制

- 上傳 Session 從建立起有效 24 小時；不支援超過期限的續傳。
- 密碼以加鹽 HMAC 儲存，金鑰由 Worker 自己的 Secret 衍生（負擔小，適合 Workers Free 方案）。請用夠長、且不在別處使用的密碼；登入也有限流，多次失敗會鎖定。密碼無法離線重設，見[復原](docs/RECOVERY.md)。
- 這裡的一切都在本機測過（單元、Worker 執行環境、瀏覽器端對端）。倚賴它之前，仍需自行在 Cloudflare 上驗證 R2 並發、Cron、限流、自訂網域的 Passkey、大檔與一鍵流程，見 [docs/REMOTE_ACCEPTANCE.md](docs/REMOTE_ACCEPTANCE.md)。
- CSP 目前是 Report-Only，下載不支援 `Range` 續傳。詳見 [docs/OPERATIONS.md](docs/OPERATIONS.md#known-limits)。

## 🛠️ 開發與測試

```bash
npm ci
npm run setup:local        # 以全新的隨機 Secret 產生 .dev.vars
npm run preview            # 建置後在 http://localhost:8787 執行整個 Worker
```

CI 執行同樣的檢查：

```bash
npm run typecheck && npm run lint && npm run format:check
npm run test:unit && npm run test:worker && npm run test:contracts && npm run test:scripts
npm run test:e2e           # Playwright，桌面與 375px
npm run build && npx wrangler deploy --dry-run
```

[架構](docs/ARCHITECTURE.md) · [API](docs/API.md) · [維運](docs/OPERATIONS.md) · [Owner 復原](docs/RECOVERY.md) · [Cloudflare 驗收](docs/REMOTE_ACCEPTANCE.md)

## 🔀 專案來源與新增功能

本專案 Fork 自 [Hzao/PocketChest](https://github.com/Hzao/PocketChest)。此分支新增單 Worker + R2-only 架構、一鍵部署、Owner 限定上傳、密碼／TOTP／Passkey 三種獨立登入、安全設定、三語介面、分享連結改善、限流與清理強化。這是獨立 Fork，不代表原作者為修改版本背書。

授權條款見本倉庫的 [LICENSE](LICENSE)。
