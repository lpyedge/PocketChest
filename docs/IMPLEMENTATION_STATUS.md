# 實施狀態（Task 勾選表）

每個 Task 只有在測試真正執行並通過、且已提交後才能標記 `PASS`。`BLOCKED` 表示需要外部條件（網路、Cloudflare 帳號等），不視為完成。

| Task | 內容 | 狀態 | 提交 |
|---|---|---|---|
| TASK-00 | 基準鎖定與新 API 合約 | PASS | 見 Git log |
| TASK-01 | Worker 工具鏈／測試插件升級 | PASS | 見 Git log |
| TASK-02 | 前端依賴更新與 UI Gate | PASS | 見 Git log |
| TASK-03 | 小檔並行上傳完成屏障（P0） | PASS | 見 Git log |
| TASK-04 | 單 Session R2 CAS 狀態層 | PASS | 見 Git log |
| TASK-05 | 寫入租約與 Complete 屏障 | PASS | 見 Git log |
| TASK-06 | Complete 冪等與碼碰撞補償（P0） | PASS | 見 Git log |
| TASK-07 | Multipart 狀態、Abort | TODO | |
| TASK-08 | Cron 清理與故障自修復 | TODO | |
| TASK-09 | 上傳配額與前端真取消 | TODO | |
| TASK-10 | POST 查碼 | TODO | |
| TASK-11 | 下載授權 Cookie 與串流 | TODO | |
| TASK-12 | Owner 原子資料與首次初始化 | TODO | |
| TASK-13 | Owner Cookie Session、CSRF | TODO | |
| TASK-14 | Password 獨立登入 | TODO | |
| TASK-15 | TOTP 獨立登入、重放防護 | TODO | |
| TASK-16 | Rate Limiting、密碼／TOTP 錯誤冷卻 | TODO | |
| TASK-17 | Passkey 註冊 | TODO | |
| TASK-18 | Passkey 登入 | TODO | |
| TASK-19 | 三方式 Toggle 與最後方式保護 | TODO | |
| TASK-20 | 密碼修改與 Session 輪替 | TODO | |
| TASK-21 | TOTP 綁定與重綁 | TODO | |
| TASK-22 | 離線密碼恢復 CLI | TODO | |
| TASK-23 | 登入頁（動態方式） | TODO | |
| TASK-24 | Security Settings Modal | TODO | |
| TASK-25 | i18n 核心 | TODO | |
| TASK-26 | 三語完整翻譯 | TODO | |
| TASK-27 | 無 JS 三語首頁 | TODO | |
| TASK-28 | 刪除舊協定 | TODO | |
| TASK-29 | 測試完善與 CI Gate | TODO | |
| TASK-30 | 新部署文檔 | TODO | |
| TASK-31 | 隔離 Cloudflare 真機驗收 | BLOCKED_REMOTE | 需測試帳號與網域 |

## 基準記錄（TASK-00，修改前）

環境：Node v22.22.0，npm 10.9.4，分支 `claude/exciting-bell-eow6o3`，起點提交 `f427fc2`。

| 指令 | 結果 |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run lint` | exit 0，0 error，12 warning |
| `npm run format:check` | exit 0 |
| `npx vitest run` | exit 0，14 檔，100/100 測試通過 |
| `npm run build` | exit 0 |
| `npx wrangler deploy --dry-run` | exit 0 |
| `npm audit --audit-level=high` | exit 1（見下） |

### 審計基準（需在 TASK-01／02 清除）

- `brace-expansion` ≤1.1.20 等：**high**，`npm audit fix` 可修。
- `vitest` ≤4.1.10 經 `@vitest/mocker`：moderate，TASK-01 升級 Vitest 5 解決。
- `ajv`、`@humanfs/node`：moderate，`npm audit fix` 可修。

### 現有 npm scripts

`dev`、`dev:worker`、`build`、`preview`、`deploy`、`test`、`typecheck`、`cf-typegen`、`lint`、`lint:fix`、`format`、`format:check`。缺少 `test:unit`、`test:worker`、`test:contracts`、`test:e2e`，於 TASK-29 建立。

### 現有檔案樹（摘要）

- `src/worker/`：`index.ts`（路由與 handler）、`storage.ts`（R2 key 與清理）、`types.ts`、`utils.ts`（JWT、TOTP、取件碼）。
- `src/web/`：`index.html`（首頁）、`upload/`、`retrieve/`、`shared/{components,hooks,lib}`。
- `test/`：14 個 spec 檔與 `utils/`。
- `scripts/`：`generate-secrets.js`、`migrate-d1-to-r2.mjs`（TASK-28 刪除）、`test-ci.sh`。

### 依賴版本（基準）

React 18.3.1、Vite 6.3.5、`@vitejs/plugin-react` 4.7.x、Tailwind 3.4.x、TypeScript 5.5.x、Vitest 3.2.x、`@cloudflare/vitest-pool-workers` 0.8.x、Wrangler 4.29.x。

### 既知偏差

- 舊 API 文件已搬到 `docs/API-legacy-v1.md`，僅作記錄。
- 現行程式仍用 `/api/chest/*` 路徑與舊 `TOTP_SECRETS`／`REQUIRE_TOTP` 認證，尚未符合 `docs/API.md` 目標合約；這屬於 G1–G3 要實作的內容。
