# 依賴版本記錄

查詢日期：2026-10-09。版本由 `npm view <pkg> dist-tags` 與 `npm view <pkg>@<ver> peerDependencies` 核對。正式版號以 `package-lock.json` 為準。

## Node

- 本機與 CI：Node **24 LTS**（`.nvmrc` = `24`）。
- `engines.node`：`^22.12.0 || ^24.0.0 || >=26.0.0`（Vitest 5 與 `@cloudflare/vitest-plugin` 的要求）。

## TASK-01 已升級（Worker 工具鏈）

| 套件 | 版本 | 約束與理由 |
|---|---|---|
| `wrangler` | 4.149.0 | 需 ≥4.36 才支援 Rate Limiting binding。`engines: node >=22`。 |
| `vitest` | 5.0.3 | 最新 stable。`@cloudflare/vitest-plugin` 1.4.0 的 peer 為 `^4.1.0 \|\| ^5.0.0`。 |
| `@cloudflare/vitest-plugin` | 1.4.0 | 取代已棄用的 `@cloudflare/vitest-pool-workers`（最新 0.23.0）。peer：`vite ^6.4 \|\| ^7 \|\| ^8`。 |
| `typescript` | 6.0.3 | 最新 6.x stable。7.0.2 已發佈，本方案不採用。 |
| `@typescript-eslint/parser`、`@typescript-eslint/eslint-plugin` | 8.71.1 | 8.39.x 的 peer 為 `typescript <6`，與 TS 6 衝突；8.71.1 的 peer 為 `>=4.8.4 <6.1.0`。 |

## 基準（TASK-00 前）

React 18.3.1、Vite 6.3.5、`@vitejs/plugin-react` 4.7.x、Tailwind 3.4.x、ESLint 9.33、Prettier 3.6.x、`@cloudflare/vitest-pool-workers` 0.8.x、Vitest 3.2.x。

## TASK-02 已升級（前端）

| 套件 | 版本 | 備註 |
|---|---|---|
| `react`／`react-dom` | 19.3.0 | 型別 `@types/react`／`@types/react-dom` 19.3.0 |
| `vite` | 8.3.4 | 多入口 build 不變；`build.target` 仍為 `es2020` |
| `@vitejs/plugin-react` | 6.1.2 | peer `vite ^8` |
| `tailwindcss`、`@tailwindcss/vite` | 4.3.3 | CSS 入口改為 `@import "tailwindcss" source(none)`；`@source "../"` 限定掃描範圍；移除 `tailwind.config.js`、`postcss.config.js`、`autoprefixer` |
| `eslint`、`@eslint/js` | 10.12.0／10.x | 新規則 `preserve-caught-error`：錯誤保留 `cause` |
| `prettier` | 3.9.9 | |
| `@playwright/test` | 1.64.0 | E2E 冒煙測試，桌面與 375px 兩個 Project |

移除未使用依賴：`eslint-plugin-prettier`、`eslint-config-prettier`。

### 遷移注意

- Tailwind 4 改名：`bg-gradient-to-*` → `bg-linear-to-*`、`bg-opacity-*` → `bg/NN` 顏色修飾、`flex-shrink-0` → `shrink-0`。
- 自訂 `.line-clamp-2` 已刪除，改用內建 utility。

## 審計狀態

- TASK-02 後：`npm audit --audit-level=high` exit 0，無 high／critical。

## 新增：WebAuthn（TASK-17／18）

- `@simplewebauthn/server` **14.0.3**（精確鎖定）。發佈於 2026-09-25，符合「至少兩週前發佈」的版本政策。
- 僅用於 Worker 端的註冊／登入驗證；前端 Browser SDK 於 TASK-23 另行加入。
- 已驗證可通過 `wrangler deploy --dry-run` 打包。

## 版本核對（TASK-30，2026 年 10 月）

以 `npm view <package> version` 與 `package-lock.json` 比對。鎖定版本以 `package-lock.json` 為準，`npm ci` 必須可重建同一組版本。

| 套件 | 鎖定 | Registry 最新 | 說明 |
|------|------|---------------|------|
| wrangler | 4.149.0 | 4.149.0 | 相同 |
| vitest | 5.0.3 | 5.0.3 | 相同 |
| @cloudflare/vitest-plugin | 1.4.0 | 1.4.0 | 相同 |
| vite | 8.3.4 | 8.3.4 | 相同 |
| typescript | 6.0.3 | 7.0.2 | 7.0.2 發佈於 2026-07-08，超過兩週，但屬主版本升級；本專案暫留 6.0.3，升級需另開 Task 驗證 |
| react / react-dom | 19.3.0 | 19.3.0 | 相同 |
| eslint | 10.12.0 | 10.12.0 | 相同 |
| prettier | 3.9.9 | 3.9.9 | 相同 |
| @playwright/test | 1.64.0 | 1.64.0 | 相同 |
| tailwindcss / @tailwindcss/vite | 4.3.3 | 4.3.3 | 相同 |
| @vitejs/plugin-react | 6.1.2 | 6.1.2 | 相同 |
| @simplewebauthn/server | 14.0.3 | 14.0.3 | 2026-09-25 發佈，符合兩週規則 |
| @simplewebauthn/browser | 14.0.0 | 14.0.0 | 2026-09-02 發佈 |

**執行環境**：Node.js `^22.12.0 || ^24.0.0 || >=26.0.0`（`package.json` engines）；`.nvmrc` 指定 24。
**引擎**：`@simplewebauthn/server` 的 engines 為 Node 20 以上（已由 `npm view` 確認）。

**安全掃描**：`npm run audit:high` 通過。剩餘 1 個 moderate（`@humanfs/node` < 0.16.8，ESLint 的開發期傳遞依賴）；CI 只把 high/critical 作為失敗條件，moderate 寫入日誌。
