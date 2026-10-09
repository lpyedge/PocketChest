# PocketChest

[English](README.md) | [繁體中文](README.zh-Hant.md) | [日本語](README.ja.md)

> 私有化檔案與文字分享。只需一個 Cloudflare Worker、一個 R2 Bucket，不依賴資料庫。

## 🚀 快速部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lpyedge/PocketChest)

**一鍵部署** · [完整部署指南](DEPLOYMENT.zh-Hant.md) · [手動部署](DEPLOYMENT.zh-Hant.md#2-手動部署)

按鈕會把本倉庫複製到你的 GitHub 帳號，用 Workers Builds 建置並建立 R2 Bucket。你需要填入三個 Secret、建立一次 Owner，然後關閉初始化模式。指南逐步說明，也列出部署後該檢查的項目：按鈕部署成功並不等於已通過正式環境驗收。

## ✨ 主要功能

- 密碼、驗證器 App（TOTP）、Passkey 可各自獨立登入；至少保持一種啟用。
- 只有 Owner 可以上傳；取件者憑取件碼或 `#CODE` 直接連結取件，無須登入。
- 文字與 Multipart 大檔；分享期限可選 1／3／7／14 天或永久；每小時自動清理。
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
| <img src="assets/screenshots/home-zh-Hant.png" alt="首頁" width="420"><br>首頁 | <img src="assets/screenshots/login-zh-Hant.png" alt="Owner 登入" width="420"><br>Owner 登入 |
| <img src="assets/screenshots/upload-zh-Hant.png" alt="上傳" width="420"><br>上傳 | <img src="assets/screenshots/share-result-zh-Hant.png" alt="分享結果" width="420"><br>分享結果 |
| <img src="assets/screenshots/retrieve-zh-Hant.png" alt="取件" width="420"><br>取件 | <img src="assets/screenshots/security-settings-zh-Hant.png" alt="安全設定" width="420"><br>安全設定 |

<img src="assets/screenshots/upload-zh-Hant-mobile.png" alt="上傳 (mobile)" width="200"> <img src="assets/screenshots/retrieve-zh-Hant-mobile.png" alt="取件 (mobile)" width="200">

截圖由 `npm run screenshots` 從目前的建置擷取（見 [docs/SCREENSHOTS.md](docs/SCREENSHOTS.md)）；畫面中的取件碼只是用完即丟的測試資料。

## 🛡️ 安全說明與目前限制

- 上傳 Session 從建立起有效 24 小時；不支援超過期限的續傳。
- 密碼雜湊很耗 CPU；不要假設 Workers Free 方案能執行，請在自己的方案上實測。
- 倚賴它之前，仍需自行在 Cloudflare 上驗證 R2 並發、Cron、限流、自訂網域的 Passkey 與大檔。
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
npm run test:unit && npm run test:worker && npm run test:contracts
npm run test:e2e           # Playwright，桌面與 375px
npm run build && npx wrangler deploy --dry-run
```

[架構](docs/ARCHITECTURE.md) · [API](docs/API.md) · [維運](docs/OPERATIONS.md) · [Owner 復原](docs/RECOVERY.md) · [Cloudflare 驗收](docs/REMOTE_ACCEPTANCE.md)

## 🔀 專案來源與新增功能

本專案 Fork 自 [Hzao/PocketChest](https://github.com/Hzao/PocketChest)。此分支新增單 Worker + R2-only 架構、一鍵部署、Owner 限定上傳、密碼／TOTP／Passkey 三種獨立登入、安全設定、三語介面、分享連結改善、限流與清理強化。這是獨立 Fork，不代表原作者為修改版本背書。

授權條款見本倉庫的 [LICENSE](LICENSE)。
