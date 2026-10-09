# new2 獨立複審（2026-10-09）修復紀錄

對應 `PocketChest_new2_independent_review_2026-10-09.md`。依文件建議順序處理：N2-01＋N2-04 → N2-02＋N2-06 → N2-03 → N2-05／08／09 → N2-07 → N2-10。每項先寫能失敗的測試，再修，提交前跑型別、lint、格式、全部 Vitest 與（涉及介面時）全部 Playwright。

| 項目 | 級別 | 修改 | 主要測試 |
|------|------|------|----------|
| N2-01 | P1 | 採「簡單版」政策：上傳 Session 從建立起算硬性 24 小時。Multipart 憑證的到期不得晚於 Session（原本 48 小時），所以不會再出現「Part 收得進來、最後 Complete 卻不可能成功」。Cron 仍在 48 小時後才清理 | `test/session-lifetime.spec.ts`（T01、T02：0／23／23.9／24／25／47／49 小時） |
| N2-04 | P2 | Cron 清理逾期 Session 前先以 CAS `OPEN → ABANDONED` 取得處置權；CAS 失敗（已 COMPLETED／FINALIZING）就不刪，重新判斷；刪除失敗時 Session 留在 ABANDONED，下次重試 | `test/cleanup-cas.spec.ts`（T03、T04） |
| N2-02 | P1 | 取件頁不再一次為全部文字項目換取 Cookie：只自動載入前 10 個、每次 3 個；其餘「顯示文字」按需載入；一個被 429 拒絕只影響該項目，並有單項重試；整頁不再因此失敗 | `test/web/text-loader.spec.ts`、`test/e2e/many-texts.spec.ts`（T05、T06） |
| N2-06 | P2 | `authorizeDownload` 也傳遞 AbortSignal，並在授權與讀取之間檢查；切換 `#CODE` 時舊請求被取消 | `test/web/text-loader.spec.ts`、`test/e2e/many-texts.spec.ts`（T15） |
| N2-03 | P1 | 已停用的方式不能登入，也不能再驗證（`/api/auth/reauth/*` 一律 `403 AUTH_METHOD_DISABLED`）。重新啟用改用獨立的「持有證明」：`/api/auth/activate/{password,totp,passkey/options,passkey/verify}`，成功後 5 分鐘內可啟用該方式，且**不**開啟一般 reauth 視窗；啟用另需一個仍啟用方式的再驗證 | `test/disabled-method-reauth.spec.ts`（T07、T08、T09） |
| N2-05 | P2 | 返回首頁依語言走 `/`、`/ja/`、`/en/`；上傳／取件頁的硬編碼英文改用 `common.backHome`；上傳頁與取件頁之間的連結帶 `?lang=`；取件失敗頁、結果頁的按鈕不再固定跳 `/` | `test/web/home-url.spec.ts`、`test/e2e/language-navigation.spec.ts`（T10、T11） |
| N2-08 | P2 | 切換語言時，語言檔下載成功後才寫入 localStorage 與網址 `?lang=`；失敗時什麼都不留，重新整理不會再要求失敗的語言；`<html lang>` 跟著畫面上實際的文字 | `test/e2e/language-navigation.spec.ts`（T12） |
| N2-09 | P2 | 取件結果頁、失敗頁、上傳成功頁都有語言切換；切換不重設檔案與取件碼 | `test/e2e/language-navigation.spec.ts`（T13） |
| N2-07 | P2 | 進入完成階段後不再顯示「取消」；取消要等伺服器確認才顯示已取消（期間顯示「正在取消…」），被拒絕時顯示失敗而不是假成功；Complete 的回應遺失時，重試改為對**同一個 Session** 再送一次 Complete（冪等，同一個分享碼），不再重傳或開新 Session | `test/e2e/upload-cancel-complete.spec.ts`（T14） |
| N2-10 | 可選 | 被拒絕的 Owner 登入嘗試不再寫入計數器（只讀快路徑，放行仍走 CAS）；下載 GET 加上每檔案＋來源的 `DOWNLOAD_LIMITER`（120／分鐘） | `test/throttle-write-load.spec.ts` |

## 行為變更

- 上傳 Session 與其所有憑證 24 小時後失效（Multipart 不再有 48 小時）。
- 停用的方式不能再用於登入或再驗證；重新啟用需要先證明仍持有它（`/api/auth/activate/*`），再用仍啟用的方式再驗證。
- 取件頁最多自動載入 10 個文字項目；其餘按需載入。
- `<html lang>` 在新語言文字載入完成後才改變。
- 新增 rate limit binding `DOWNLOAD_LIMITER`。
- API 新增 4 個路由（`docs/API.md` 第 33–36 列）與錯誤碼 `ACTIVATION_PROOF_REQUIRED`。

## 驗證結果（本機）

型別檢查、lint（0 error）、格式、單元 82／82、契約 39／39、Worker 447／447（Vitest 的 Errors 行為 0）、Playwright 150／150、build、`wrangler deploy --dry-run`、`audit:high` 全部通過。GitHub Actions 的結果以推送後該 commit 的 run 為準。

## 尚未完成（與上一輪相同）

- **TASK-31／N2-T16、N2-T17**：真實 Cloudflare 驗收（PBKDF2 的 CPU 與 Cron 的 CPU、真實 R2 CAS 與並發、各 PoP 的 rate limit、正式網域 Passkey、大檔記憶體峰值）。Miniflare 不能代替。
- **R14**：CSP 仍是 Report-Only。
- N2-01 選了簡單版；若產品需要超過 24 小時的斷點續傳，需要另設可續期的 Token 與 Session 硬上限（見審查文件）。
