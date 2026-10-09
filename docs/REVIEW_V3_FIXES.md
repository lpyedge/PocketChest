# 複審 v3（2026-10-09）修復紀錄

對應 `PocketChest_Review_v3_2026-10-09.md` 的 FIX-01 至 FIX-12。每項都先寫會失敗的重現測試（red），再修改程式（green），並在提交前跑過 typecheck、lint、format 與相關測試。

| FIX | 級別 | 修改 | 提交 | 主要測試 |
|-----|------|------|------|----------|
| 01 | P0 | `OPEN→FINALIZING` 的同一次 CAS 內固定 `expiresAt`／`validityDays`，所有重試只讀這份計畫；Cron 只在 Session、Manifest、索引三者到期時間一致時才刪檔，不一致則保留並以 Session 為準修復 | `019de6a` | `test/complete-expiry-consistency.spec.ts` |
| 02 | P1 | 卡住的 FINALIZING：已 claim 且與計畫相符則完成為 `COMPLETED`，否則刪除 claim 與其 expiry 後回滾；`codes/` 以持久游標掃描無主 claim | `4c3f10b` | `test/finalize-claim-recovery.spec.ts` |
| 03 | P1 | 完成時回收未被 `fileIds` 引用的物件；孤兒掃描也處理「Session 已完成但物件未被引用」（含 48h 寬限）；無法讀取的 Session 記錄不再被當成不存在 | `8909723` | `test/unreferenced-files.spec.ts` |
| 04 | P1 | 所有 Owner 變更在同一個 CAS 內檢查發起 Session 的 `ownerAuthVersion`；`rotate()` 只為本次寫入的版本簽發新 Session；Passkey 登記同樣檢查 | `589f89c` | `test/owner-authversion-race.spec.ts` |
| 05 | P1 | 上傳先驗證全部項目、保留配額，才開始 R2 寫入；等待所有寫入 settle，失敗時刪除本次寫入再釋放租約；以計數串流限制實際 Body（無 Content-Length 也有效） | `405b3d1` | `test/upload-write-order.spec.ts` |
| 06 | P1 | `/api/auth/bootstrap` 套用 `AUTH_LIMITER`；新增 `PART_LIMITER`（以 fileId 與來源為鍵，每分鐘 600）；初始密碼少於 16 字元時拒絕 | `d40bcc2` | `test/bootstrap-part-ratelimit.spec.ts` |
| 07 | P2 | Passkey 計數器在 CAS 內重新比對公鑰與最新計數器，`newCounter <= latest` 即拒絕；兩邊皆為 0 的同步 Passkey 照常通過 | `1873fac` | `test/login-passkey.spec.ts`（FIX-07） |
| 08 | P2 | 已 abort 的 Signal 在建立 XHR 前即拒絕；Signal 監聽器於 `loadend` 移除；`readJson` 與 `validateParts` 拒絕非物件 | `98dbbe6` | `test/web/xhr-abort.spec.ts`、`test/worker-json-shapes.spec.ts` |
| 09 | P2 | `expiryDate` 型別改為 `string \| null`，永久分享顯示三語「永久有效」 | `7953552` | `test/web/expiry.spec.ts`、`test/e2e/retrieve-download.spec.ts` |
| 10 | P2 | 單檔上限改為 `20 MiB × 10,000`（約 195.3 GiB），前端在送出任何請求前拒絕超限檔案；前後端常數以測試鎖定相等 | `5c82bd7` | `test/web/multipart-plan.spec.ts`、`test/multipart-upload.spec.ts` |
| 11 | P2 | TOTP 綁定顯示可掃描 QR（以獨立解碼器驗證可還原 URI）與可複製的 Base32 金鑰；Seed 不寫入瀏覽器儲存 | `6dc8cf8` | `test/web/qr.spec.ts`、`test/e2e/security-settings.spec.ts` |
| 12 | P2 | 清理游標（sessions、challenges）與積壓告警；CSP Report-Only；文件註明 Free 方案、限流近似與 Range 未支援 | `3fc850a` | `test/cleanup-cursor.spec.ts`、`test/e2e/smoke.spec.ts` |

## 行為變更（需要知道）

- 兩個不同 Session 同時變更安全設定時，後到者可能回 **401**（它的 Session 已被先完成的變更結束），不再只回 409。
- 單一 Multipart 檔案上限由 200 GiB 降到約 195.3 GiB；Session 總量上限仍為 200 GiB。
- 設定 `BOOTSTRAP_ENABLED=true` 時，`ADMIN_BOOTSTRAP_PASSWORD` 必須至少 16 字元。
- 新增 rate limit binding `PART_LIMITER`（`wrangler.jsonc`）。
- E2E 開發伺服器現在帶有測試用 `AUTH_ENCRYPTION_KEY`，TOTP 綁定流程才能在其中運行。

## 驗收結果（本機，Miniflare）

| 項目 | 結果 |
|------|------|
| `npm ci` | 成功 |
| `npm run typecheck`（5 個 tsconfig） | 0 錯誤 |
| `npm run lint` | 0 錯誤（52 個警告，皆為既有類型的非空斷言） |
| `npm run format:check` | 通過 |
| `npm run check:legacy` | 無殘留 |
| `npm run test:unit` | 53／53 |
| `npm run test:worker` | 371／371（見下） |
| `npm run test:contracts` | 35／35 |
| `npm run test:e2e`（desktop 與 375px） | 84／84 |
| `npm run build`、`wrangler deploy --dry-run` | 成功 |
| `npm run audit:high` | 無 high／critical（尚有 1 個 moderate，為 dev 工具 `@humanfs/node` 的傳遞依賴） |

**關於 `test/auth-throttle.spec.ts` 的「escalates for repeat offenders」**：在本次執行環境以預設 5 秒逾時會失敗（約需 10 秒，因為多次 PBKDF2）。修改前的程式碼同樣逾時，與 FIX 無關；以 `--testTimeout=60000` 執行時全部通過。CI 機器的速度需另行確認，必要時調高該測試的逾時。

## 仍未完成

- **TASK-31**：真實 Cloudflare 驗收（R2 CAS 並發、Cron、真實 Rate Limit 429、PBKDF2 CPU、正式網域 Passkey、大檔下載）。Miniflare 不能代替。
- FIX-12 中屬於可選項的 Owner 層限流原子化與 `Range` 下載未實作，已寫入 `DEPLOYMENT.md` 的「Known limits」。
- FIX-04 中 Passkey 登記的版本檢查（`registrationVerify`）已加入，但沒有專屬測試，因為它需要完整的 WebAuthn 登記流程；其餘四個 Owner 變更都有競態測試。
