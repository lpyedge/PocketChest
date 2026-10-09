# 測試報告（本機與 CI 同序）

本報告記錄 G5 收尾時的本機執行結果。機器可讀版本由 `scripts/test-report.mjs` 寫出到 `test-results/report.json`（CI 會以 artifact 上傳）。每筆案例只會是 **PASS**、**FAIL** 或 **SKIP**；SKIP 必須附原因，且任何 FAIL 會使流程失敗。目前沒有任何 SKIP。

## 環境

| 項目 | 值 |
|------|----|
| Node.js | 22.22.0（`.nvmrc` 指定 24，CI 以 `.nvmrc` 為準） |
| 作業系統 | Linux 6.18（容器內，Chromium 1194 由 `PLAYWRIGHT_CHROMIUM_PATH` 指定） |
| Playwright | 1.64.0 |
| 執行模式 | 本機 Miniflare／`wrangler dev`，**非** Cloudflare 真機 |

## 結果

| 類別 | 指令 | 案例 | PASS | FAIL | SKIP |
|------|------|------|------|------|------|
| typecheck | `npm run typecheck` | 5 個 tsconfig | 全部 | 0 | 0 |
| lint | `npm run lint` | — | 0 錯誤（39 個警告，皆為測試碼的非空斷言） | 0 | — |
| format | `npm run format:check` | — | 全部 | 0 | — |
| 退役協定檢查 | `npm run check:legacy` | — | 無殘留 | 0 | — |
| unit（web、i18n） | `npm run test:unit` | 31 | 31 | 0 | 0 |
| worker（Workers 運行時） | `npm run test:worker` | 320 | 320 | 0 | 0 |
| 路由契約 | `npm run test:contracts` | 35 | 35 | 0 | 0 |
| e2e（Chromium，desktop 與 375px） | `npm run test:e2e` | 68 | 68 | 0 | 0 |
| build | `npm run build` | — | 成功 | — | — |
| bundle dry-run | `npx wrangler deploy --dry-run` | — | 成功 | — | — |
| 依賴掃描 | `npm run audit:high` | — | 無 high／critical | 0 | — |

合計：Vitest 386 + Playwright 68 = **454 PASS，0 FAIL，0 SKIP**。

## 故障注入

為確認流程真的會失敗，暫時加入一個必然失敗的測試（`expect(1).toBe(2)`），`npm test` 結束碼為 **1**；移除後回到全綠。

## 覆蓋對應（AC-29-5）

| 範圍 | 主要測試檔 |
|------|-----------|
| 三種登入方式（密碼、TOTP、Passkey） | `test/owner-bootstrap.spec.ts`、`test/login-password.spec.ts`、`test/login-totp.spec.ts`、`test/login-passkey.spec.ts`、`test/passkey-register.spec.ts` |
| 三種方式的開關、最後方式保護、併發關閉 | `test/security-method-toggle.spec.ts` |
| 密碼修改、TOTP 綁定與重綁 | `test/change-password.spec.ts`、`test/totp-enroll.spec.ts` |
| 過期（Session、Challenge、分享、Cookie） | `test/owner-session.spec.ts`、`test/passkey-register.spec.ts`、`test/storage.spec.ts` |
| 鎖定與限流 | `test/auth-throttle.spec.ts`、`test/upload-session-creation.spec.ts` |
| 離線恢復 | `test/recovery-cli.spec.ts` |
| Cron 與清理 | `test/storage.spec.ts`、`test/cleanup-recovery.spec.ts`、`test/auth-throttle.spec.ts` |
| R2 交易失敗與併發 | `test/owner-bootstrap.spec.ts`（首次寫入失敗）、`test/session-cas.spec.ts`、`test/session-write-leases.spec.ts`、`test/owner-bootstrap.spec.ts`（10 個同時初始化） |
| 下載流（授權 Cookie、串流、不以 Query 授權） | `test/download.spec.ts`、`test/download-auth.spec.ts`、`test/e2e/retrieve-download.spec.ts` |
| 上傳與分段上傳 | `test/multipart-upload.spec.ts`、`test/multipart-state.spec.ts`、`test/upload-completion.spec.ts`、`test/web/upload-*.spec.ts` |
| 三語（鍵一致、語言選擇、三語完整流程、靜態首頁） | `test/i18n-keys.spec.ts`、`test/e2e/i18n-flow.spec.ts`、`test/e2e/static-home.spec.ts` |
| 登入與設定 UI（Chromium 虛擬 Passkey） | `test/e2e/auth-login.spec.ts`、`test/e2e/security-settings.spec.ts` |
| 路由契約（文件中的每一條路由；退役路由回 404） | `test/contracts/route-contract.spec.ts` |

## 尚未覆蓋或未以真實環境驗證

這些項目 **不計入** 以上 PASS，屬於待辦或需外部資源：

- **Cloudflare 真機**：R2 條件寫入的真實並發、Cron 排程、RateLimiter 的真實 429、Workers CPU 配額（PBKDF2 600,000 次）。本機 Miniflare 不能代替。見 [REMOTE_ACCEPTANCE.md](REMOTE_ACCEPTANCE.md)（BLOCKED）。
- **真實 Passkey 硬體**：目前以 Chromium 虛擬認證器與軟體認證器測試；尚未在實體裝置與不同瀏覽器上驗證。
- **Rate limit 的實際執行**：binding 被呼叫、拒絕時回 429 已驗證；Miniflare 本身是否真的計數，本機只驗證了呼叫路徑。
- **Passkey 網域**：`PASSKEY_RP_ID` 的拒絕與範圍已由測試驗證，但正式網域與 DNS 尚未設定。
- **GitHub Actions 尚未實際執行**：`.github/workflows/ci.yml` 的步驟與本機 `scripts/test-ci.sh` 相同，但沒有在 GitHub 上跑過。
- **瀏覽器範圍**：E2E 只在 Chromium 執行；Safari、Firefox 未測。

## 重現

```bash
./scripts/test-ci.sh          # 與 CI 同序；需要 PLAYWRIGHT_CHROMIUM_PATH 或 npx playwright install chromium
npm test                      # 三個 Vitest 群組
```
