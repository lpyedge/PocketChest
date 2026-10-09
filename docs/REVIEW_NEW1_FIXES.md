# new1 二次審查（2026-10-09）修復紀錄

對應 `PocketChest_new1_review_and_regression_2026-10-09.md`。順序依文件的 H01 → H12，再處理其餘 P2 項目。每項先寫會失敗的測試（red），再修改（green），提交前跑型別、lint、格式與全部測試。

| 項目 | 級別 | 修改 | 主要測試 |
|------|------|------|----------|
| R01／R02 (H01) | P0／P1 | Cron 不再把 R2 讀取例外當成「Session 不存在」：只有確實回 `null` 才走孤兒分支；讀取失敗或記錄損毀時保留所有物件與標記並回報錯誤，下一輪重試 | `test/cleanup-io-faults.spec.ts`（C01–C04） |
| R03 (H02) | P1 | Multipart Part 以有上限的 reader 讀取：超過 20 MiB 立即取消上游並回 413；已宣告長度時只配置一份緩衝 | `test/multipart-part-bounds.spec.ts`（C07、C08） |
| R04 (H03) | P1 | 「2 週」改為真正的 14 天（後端白名單、前端選項、型別、文件）；15 不再接受 | `test/validity-days.spec.ts`、`test/e2e/validity.spec.ts`（C09、C19） |
| R05 (H04) | P1 | 綁定驗證器時，錯碼在 Challenge 上計數（最多 5 次）而不是用掉它；成功才原子消耗；Modal 在錯碼後保留同一個 QR，Challenge 結束時移除 QR 並提示重來 | `test/totp-enroll.spec.ts`（C05、C06）、`test/e2e/security-settings.spec.ts`（C20） |
| R06 (H05) | P1 | 清理日誌與回報不含取件碼：以 Session ID 或索引時間標示，錯誤文字經 `redactSecrets` 遮蔽 `codes/XXXXXX`、Bearer、Cookie | `test/cleanup-log-redaction.spec.ts`（C12） |
| R07 (H06) | P1 | 靜態首頁入口改為 `/upload/?lang=xx`、`/retrieve/?lang=xx`；Provider 嚴格白名單解析 `lang`，優先於儲存與瀏覽器語言並寫入儲存；切換語言同步更新網址；分享連結仍是 `/retrieve/#CODE` | `test/web/lang-param.spec.ts`、`test/e2e/language-handoff.spec.ts`（C16、C17） |
| H07 | P1 | `Copy as message` 複製「取件頁網址 + 獨立取件碼」的三語句子，不含 `#CODE`；直接連結按鈕不變 | `test/e2e/i18n-flow.spec.ts`（C18） |
| H08 | P2 | 靜態首頁 Footer、`retrieve.how3`、`expiry.1d.desc`、`error.fileTooLargeMax`、英文複數文案更正；檔案大小改 KiB/MiB/GiB；語言檔載入失敗時顯示重試頁（含改用英文），不再白屏 | `test/web/copy.spec.ts`、`test/web/format.spec.ts`、`test/e2e/language-handoff.spec.ts`（C21、C23）、`test/e2e/static-home.spec.ts` |
| R09 (H09) | P2 | 取件與下載以 Session 為到期權威：Manifest 與 Session 到期不一致時拒絕並以 Session ID 記錄；R2 暫時性錯誤回 503（`Retry-After`），損毀記錄 fail closed | `test/chest-authority.spec.ts`（C11） |
| R10 (H10) | P2 | Complete 在 OPEN 快照中先驗證 fileId 與非空，才進入 FINALIZING 並中止多餘的 Multipart；錯誤請求不再破壞進行中的上傳 | `test/complete-validation-order.spec.ts`（C10、C13） |
| R11 (H11) | P2 | Owner 登入嘗試先「預留」名額（已計失敗 + 進行中 ≤ 5），100 個並行猜測最多只驗證 5 次；結果出來時釋放，伺服器錯誤不計為猜測；未釋放的預留 60 秒後失效 | `test/auth-parallel-guesses.spec.ts`（C14） |
| R12 (H11) | P2 | 決定：新增 Passkey 不遞增 `authVersion`（已寫入 `security.ts` 檔頭），但在同一個 CAS 內檢查呼叫 Session 的版本 | `test/passkey-register.spec.ts`（C15） |
| R13 | P2 | JWT 驗證簽章後再檢查 header（`HS256`／`JWT`）、payload 為物件、`iat`／`exp` 為整數、未過期、未來簽發 | `test/jwt-claims.spec.ts` |
| R16 | P2 | 再驗證面板在驗證器輸入下提示「剛用過的代碼不能再用，請等下一組」 | `test/e2e/security-settings.spec.ts`（C25a） |
| R08 | P2 | 另加 `PART_TOTAL_LIMITER`（每來源所有 Part 合計），不再只靠每檔案的限額 | `test/bootstrap-part-ratelimit.spec.ts` |
| R17 (H12) | P2 | CI 對 `claude/**` 的 push 自動執行；Vitest 逾時由 5 秒改 60 秒 | GitHub Actions run |

## 由 CI 抓到的問題

第一次在 `claude/**` 觸發的 CI 報告 Worker 測試失敗：413 測試本身通過，但上傳 Body 超限時用 `TransformStream` 的 `controller.error()` 會留下無人等待的 Promise 拒絕，Vitest 因此將整體判為失敗。修復是改成手動 reader，超限時 `close()` 而非 `error()`，並在解析後再回 413。我先前的本機關卡只看「Tests」行而漏看「Errors」，現已改為同時檢查。

## 行為變更

- 並行請求超過 Owner 的猜測名額時，會在檢查前被拒（429）；快速連點兩次登入可能看到一次 429。
- `validityDays` 只接受 `1`、`3`、`7`、`14`、`-1`。
- 取件頁在伺服器暫時讀不到 Session 時回 503，不再回 404。
- 靜態首頁連結帶 `?lang=`。
- 新增 rate limit binding `PART_TOTAL_LIMITER`。
- E2E 改為單一 worker：測試共用同一個 Owner，安全設定變更會依設計結束其他 Session。

## 尚未完成

- **R14**：CSP 仍是 Report-Only。四個頁面無違規，但安全設定、上傳、下載流程尚未全部以違規收集驗證，也尚未設定上報端點；轉為正式 CSP 前需決定上報方式。
- **R15／TASK-31**：真實 Cloudflare 驗收（C26–C31）。包含 PBKDF2 CPU、R2 CAS、Cron、真實 429、正式網域 Passkey、大檔下載。Miniflare 不能代替。
- 有關 Part Body 的記憶體峰值（C07e）需在真機監看。
