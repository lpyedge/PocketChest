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

## 待 TASK-02 處理

| 套件 | 最新 stable（2026-10-09） | 備註 |
|---|---|---|
| `react`／`react-dom` | 19.3.0 | 由 18.x 升級。 |
| `vite` | 8.3.4 | 需同步 `@vitejs/plugin-react` 6.1.2（peer `vite ^8`）。 |
| `tailwindcss` | 4.3.3 | 主版本升級，需改 CSS 入口與 PostCSS 設定。 |
| `eslint` | 10.12.0 | 需確認 `@typescript-eslint` 與 `eslint-config-prettier` 相容。 |

## 審計狀態

- TASK-01 後：`npm audit --audit-level=high` 有 14 個 high，主要位於前端工具鏈（tailwind 3、postcss、rollup via Vite 6、micromatch 等）。Worker 測試工具已不再有高危項目。
- 上述高危項需在 TASK-02 清除（AC-02-4）。
