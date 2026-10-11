#!/usr/bin/env node
// Captures the screenshots used by the READMEs from the real app: the built Worker and its static assets,
// running locally with an isolated, throw-away R2 state and random secrets. Nothing here touches Cloudflare.
//
//   npm run build && npm run screenshots
//
// Output: assets/screenshots/{home,login,upload,share-result,retrieve,security-settings}-<lang>.png (desktop)
//         and {upload,retrieve}-<lang>-mobile.png (375px). Review every image before committing it.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { chromium, request as playwrightRequest } from '@playwright/test';

const PORT = Number(process.env.SCREENSHOT_PORT ?? 8791);
const BASE = `http://localhost:${PORT}`;
const OUT = 'assets/screenshots';
const PASSWORD = randomBytes(18).toString('base64url'); // the owner password for this run only
const STATE = mkdtempSync(join(tmpdir(), 'pocketchest-shots-'));

const LANGS = [
	{
		lang: 'zh-Hant',
		locale: 'zh-TW',
		home: '/',
		password: '密碼',
		signIn: '以密碼登入',
		addText: '加入文字',
		submit: '上傳並產生取件碼',
		security: '安全設定',
	},
	{
		lang: 'ja',
		locale: 'ja-JP',
		home: '/ja/',
		password: 'パスワード',
		signIn: 'パスワードでサインイン',
		addText: 'テキストを追加',
		submit: 'アップロードしてコードを作成',
		security: 'セキュリティ設定',
	},
	{
		lang: 'en',
		locale: 'en-US',
		home: '/en/',
		password: 'Password',
		signIn: 'Sign in with password',
		addText: 'Add Text',
		submit: 'Upload & Generate Code',
		security: 'Security settings',
	},
];

const SAMPLE_TEXT = {
	'zh-Hant': '週五會議的連結與議程在這裡。',
	ja: '金曜日の会議のリンクと議題はこちらです。',
	en: 'The link and agenda for Friday’s meeting are here.',
};

const server = spawn(
	'npx',
	[
		'wrangler',
		'dev',
		'--port',
		String(PORT),
		'--persist-to',
		STATE,
		'--var',
		'BOOTSTRAP_ENABLED:true',
		'--var',
		`ADMIN_BOOTSTRAP_PASSWORD:${PASSWORD}`,
		'--var',
		`JWT_SECRET:${randomBytes(48).toString('base64')}`,
	],
	// Its own process group, so the whole tree (wrangler, workerd) can be stopped at the end
	{ stdio: ['ignore', 'pipe', 'pipe'], detached: true },
);
server.stdout.resume();
server.stderr.resume();

async function waitForServer() {
	for (let attempt = 0; attempt < 120; attempt++) {
		try {
			if ((await fetch(`${BASE}/api/auth/methods`)).ok) return;
		} catch {
			// not up yet
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	throw new Error('The local Worker did not start');
}

// A share holding a text and a small file, made through the API the same way the upload page does
async function createDemoShare(api, ownerHeaders, lang) {
	const session = await (await api.post('/api/upload-sessions', { headers: ownerHeaders, data: {} })).json();
	const headers = { Authorization: `Bearer ${session.uploadToken}` };
	const upload = (multipart) => api.post(`/api/upload-sessions/${session.sessionId}/files`, { headers, multipart }).then((r) => r.json());
	const text = await upload({ textItems: JSON.stringify({ content: SAMPLE_TEXT[lang], filename: 'note.txt' }) });
	const file = await upload({ files: { name: 'quarterly-report.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 demo') } });
	const fileIds = [...text.uploadedFiles, ...file.uploadedFiles].map((f) => f.fileId);
	const done = await (
		await api.post(`/api/upload-sessions/${session.sessionId}/complete`, { headers, data: { fileIds, validityDays: 7 } })
	).json();
	return done.retrievalCode;
}

let browser;
try {
	await waitForServer();
	mkdirSync(OUT, { recursive: true });
	const api = await playwrightRequest.newContext({ baseURL: BASE, extraHTTPHeaders: { 'CF-Connecting-IP': '198.51.100.10' } });
	const claimed = await api.post('/api/auth/bootstrap', { headers: { Origin: BASE }, data: { password: PASSWORD } });
	if (claimed.status() !== 201) throw new Error(`Owner setup failed with ${claimed.status()}`);

	browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {});

	let address = 20;
	for (const L of LANGS) {
		const open = async (viewport) => {
			const context = await browser.newContext({
				locale: L.locale,
				viewport,
				extraHTTPHeaders: { 'CF-Connecting-IP': `198.51.100.${address++}` },
			});
			return { context, page: await context.newPage() };
		};
		// Each page gets the height that shows what it is about, rather than whatever the window happened to be
		const shot = async (page, name, height) => {
			if (height) await page.setViewportSize({ width: page.viewportSize().width, height });
			await page.screenshot({ path: `${OUT}/${name}.png` });
		};

		const desktop = await open({ width: 1180, height: 760 });
		const { page } = desktop;
		await page.goto(`${BASE}${L.home}`);
		await shot(page, `home-${L.lang}`, 900);

		await page.goto(`${BASE}/upload/?lang=${L.lang}`);
		await page.getByLabel(L.password, { exact: true }).waitFor();
		await shot(page, `login-${L.lang}`, 720);

		await page.getByLabel(L.password, { exact: true }).fill(PASSWORD);
		await page.getByRole('button', { name: L.signIn }).click();
		await page.locator('textarea').first().fill(SAMPLE_TEXT[L.lang]);
		await page.getByRole('button', { name: L.addText }).click();
		await shot(page, `upload-${L.lang}`, 1040);

		await page.getByRole('button', { name: L.security }).click();
		await page.getByRole('dialog').waitFor();
		await shot(page, `security-settings-${L.lang}`, 1040);
		// The dialog's first button is its close button (✕)
		await page.locator('[role=dialog] button').first().click();
		await page.getByRole('dialog').waitFor({ state: 'detached' });

		await page.getByRole('button', { name: L.submit }).click();
		await page.locator('code').filter({ hasText: '/retrieve/#' }).first().waitFor();
		await shot(page, `share-result-${L.lang}`, 1040);
		await desktop.context.close();

		const ownerHeaders = await (async () => {
			const login = await api.post('/api/auth/login/password', { headers: { Origin: BASE }, data: { password: PASSWORD } });
			const cookie = (login.headers()['set-cookie'] ?? '').split(';')[0];
			const { csrfToken } = await login.json();
			return { Origin: BASE, Cookie: cookie, 'X-PocketChest-CSRF': csrfToken };
		})();
		const code = await createDemoShare(api, ownerHeaders, L.lang);

		const wide = await open({ width: 1180, height: 760 });
		await wide.page.goto(`${BASE}/retrieve/?lang=${L.lang}#${code}`);
		await wide.page.getByText('quarterly-report.pdf').waitFor();
		await wide.page.getByText(SAMPLE_TEXT[L.lang]).waitFor();
		await shot(wide.page, `retrieve-${L.lang}`, 820);
		await wide.context.close();

		const phone = await open({ width: 375, height: 667 });
		await phone.page.goto(`${BASE}/retrieve/?lang=${L.lang}#${code}`);
		await phone.page.getByText('quarterly-report.pdf').waitFor();
		await phone.page.getByText(SAMPLE_TEXT[L.lang]).waitFor();
		await shot(phone.page, `retrieve-${L.lang}-mobile`);
		await phone.page.goto(`${BASE}/upload/?lang=${L.lang}`);
		await phone.page.getByLabel(L.password, { exact: true }).fill(PASSWORD);
		await phone.page.getByRole('button', { name: L.signIn }).click();
		await phone.page.locator('textarea').first().waitFor();
		await shot(phone.page, `upload-${L.lang}-mobile`);
		await phone.context.close();
		console.log(`captured ${L.lang}`);
	}
	await api.dispose();
} finally {
	await browser?.close();
	try {
		process.kill(-server.pid, 'SIGTERM');
	} catch {
		// already gone
	}
	// Give wrangler and workerd a moment to exit before the temporary state is removed
	await new Promise((resolve) => setTimeout(resolve, 1500));
	rmSync(STATE, { recursive: true, force: true });
}
