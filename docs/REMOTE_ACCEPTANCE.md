# 隔離 Cloudflare 真機驗收（TASK-31）

**狀態：BLOCKED（未執行）**

這份文件說明為什麼還不能宣稱正式上線，以及解除阻擋所需的資源。本次執行沒有任何真機結果；本機 Miniflare 的結果不能當作真機結果。

## 阻擋原因

1. **沒有 Cloudflare 憑證**：`npx wrangler whoami` 回報未登入，環境也沒有 `CLOUDFLARE_API_TOKEN`。
2. **網路受限**：容器的出口代理拒絕連到 `workers.cloudflare.com` 與 `sparrow.cloudflare.com`，無法部署或登入。
3. **沒有測試網域**：Passkey 的 RP ID 必須是真實網域；本機只能使用 `localhost`。

## 解除阻擋需要的資源

- 一個隔離的 Cloudflare 測試帳號（或測試子帳號），以及權限限定在該帳號的 API Token（Workers、R2、DNS 的最小權限）。
- 一個測試網域或子網域（例如 `pocket-acceptance.example.com`），可指向該 Worker。**不得**是正式網域。
- 一個全新的空 R2 Bucket，名稱與正式環境不同。
- 允許從容器內連到 Cloudflare API 的網路條件，或改由你在可連線的機器上執行這份清單。

## 驗收清單（待執行）

| 編號 | 項目 | 方法 | 結果 |
|------|------|------|------|
| R1 | 由零部署成功：空 Bucket，只輸入一次 Owner 密碼，`npm run deploy` 自行產生簽章 Secret | 依 DEPLOYMENT.md（`npm run deploy`、GitHub Actions、Deploy Button 各一次） | BLOCKED |
| R2 | 第一次開啟 `/upload/` 就是一般登入（自動建立 Owner、沒有第二個設定步驟）；Owner 之後永遠不會被初始密碼覆寫 | HTTP 與瀏覽器，記錄狀態碼 | BLOCKED |
| R1b | 升級：再次部署不問密碼，Secrets、Owner、Bucket 資料與設定完全不變；Worker／Bucket 不符時拒絕 | 在 R1 的隔離環境再部署一次 | BLOCKED |
| R1c | **一鍵流程**：Deploy Button 是否預填 `npm run deploy` 作為部署指令、Workers Builds 能否在建置中取得 Cloudflare 憑證並執行安裝程式 | 隔離帳號，記錄實際行為 | BLOCKED（尚未驗證） |
| R3 | 密碼、TOTP、Passkey 各自可登入；關閉其他方式不影響 | 真實瀏覽器與認證器 | BLOCKED |
| R4 | Passkey 以真實裝置或瀏覽器認證器登入成功 | 人工操作，記錄裝置與瀏覽器 | BLOCKED |
| R5 | R2 條件寫入在並發下只成功一次（Bootstrap、Owner 修改） | 並發請求，比對結果 | BLOCKED |
| R6 | Cron 依排程執行，摘要無錯誤 | `wrangler tail`，時間戳 | BLOCKED |
| R7 | 過期前後下載：過期前可取，過期後回 404 | 注入測試分享（短期限） | BLOCKED |
| R8 | 下載 Cookie 60 秒後失效，且只對應單一檔案 | HTTP，記錄 Set-Cookie 屬性 | BLOCKED |
| R9 | RateLimiter 超限回 429 與 Retry-After | 低速率請求，不得壓測 | BLOCKED |
| R10 | Multipart 放棄後不留未完成上傳 | 分段上傳後中止，比對 R2 | BLOCKED |
| R11 | 記錄 Worker CPU、記憶體與 R2 操作數 | Dashboard 與 `wrangler tail` 抽樣 | BLOCKED |
| R12 | 首次設定中斷後的恢復演練（隔離 Bucket；離線無法重設密碼，不在清單內） | docs/RECOVERY.md | BLOCKED |

> 本版**不做**密碼 CPU 基準或壓力測試：密碼以便宜的 HMAC 儲存，防猜測靠登入鎖定與只存在 Worker 的金鑰。R11 只記錄一般用量。

## 不可出貨條件

下列任一項不成立，就不能正式上線：

- R1、R2、R3、R5、R6 任一項未通過。
- 任何測試讓最後一種登入方式被關閉，或讓分享檔案在有效期內消失。
- 任何路徑讓跨 Session 或僅憑 Query 字串取得檔案。
- 測試期間使用正式 R2 Bucket，或用正式網域做 Passkey 測試。

## 安全約束

- 不在正式 Bucket 做刪除、過期或強制重設實驗。
- 測試完成後刪除測試 Bucket 與 Secrets，或明確標示為保留並隔離。
- 驗收日誌中不得留下密碼、Seed、Cookie 或完整的 Challenge。
