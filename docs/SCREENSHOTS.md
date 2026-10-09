# Screenshots / 畫面截圖 / 画面キャプチャ

The images in `assets/screenshots/` are taken from the real app by `scripts/capture-screenshots.mjs`: the built Worker and its static assets run locally on an isolated, throw-away R2 state with random secrets. Nothing touches Cloudflare, and no real data or secret appears in them.

```bash
npm ci
npm run build
npm run screenshots        # writes assets/screenshots/*.png
```

Needs Chromium for Playwright (`npx playwright install chromium`, or set `PLAYWRIGHT_CHROMIUM_PATH`). It uses port 8791 (`SCREENSHOT_PORT` to change it).

For each language (`zh-Hant`, `ja`, `en`) it writes `home`, `login`, `upload`, `security-settings`, `share-result` and `retrieve` at desktop width, and `upload` and `retrieve` at 375px (`-mobile`), named `<page>-<language>.png`. The READMEs show each language's own set, and `test/contracts/docs-links.spec.ts` checks that every image they reference exists.

Before committing new images, look at each one. The retrieval code and the address `localhost:8791` shown in them belong to the throw-away run. After a UI change, run the command again and commit the result from the same commit as the change.
