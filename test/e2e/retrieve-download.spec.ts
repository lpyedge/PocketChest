import { test, expect, APIRequestContext } from '@playwright/test';
import { ownerHeaders, randomClientIp, useClientAddress } from './owner';

let clientIp = randomClientIp();

test.beforeEach(async ({ page }) => {
	clientIp = randomClientIp();
	await useClientAddress(page, clientIp);
});

// Creates a completed chest through the API, the same way the upload page does
async function createChest(
	request: APIRequestContext,
	texts: { content: string; filename: string }[],
	file?: { name: string; body: string },
	validityDays = 7,
) {
	const session = await (await request.post('/api/upload-sessions', { headers: await ownerHeaders(request, clientIp), data: {} })).json();
	const headers = { Authorization: `Bearer ${session.uploadToken}`, 'CF-Connecting-IP': clientIp };
	const multipart: Record<string, unknown> = {};
	if (file) {
		multipart.files = { name: file.name, mimeType: 'text/plain', buffer: Buffer.from(file.body) };
	}
	// Playwright's multipart fields cannot repeat, so these tests send at most one text item
	if (texts.length > 0) {
		multipart.textItems = JSON.stringify(texts[0]);
	}
	const uploaded = await (
		await request.post(`/api/upload-sessions/${session.sessionId}/files`, { headers, multipart: multipart as any })
	).json();
	const fileIds = uploaded.uploadedFiles.map((f: { fileId: string }) => f.fileId);
	const completed = await (
		await request.post(`/api/upload-sessions/${session.sessionId}/complete`, { headers, data: { fileIds, validityDays } })
	).json();
	return {
		code: completed.retrievalCode as string,
		files: uploaded.uploadedFiles as { fileId: string; filename: string; isText: boolean }[],
	};
}

test('downloads a file through the cookie flow, with no token in the URL', async ({ page, request }) => {
	const chest = await createChest(request, [], { name: 'report-2026.txt', body: 'hello from the browser test' });

	const requests: string[] = [];
	page.on('request', (req) => requests.push(req.url()));
	await page.goto(`/retrieve/#${chest.code}`);
	await expect(page.getByText('report-2026.txt')).toBeVisible();

	const [download] = await Promise.all([
		page.waitForEvent('download'),
		page
			.getByRole('button', { name: /Download/ })
			.first()
			.click(),
	]);

	expect(download.suggestedFilename()).toBe('report-2026.txt');
	expect(page.url()).not.toContain('token');
	expect(requests.some((url) => /[?&]token=/.test(url))).toBe(false);
	expect(requests.some((url) => url.endsWith('/api/download/authorize'))).toBe(true);
});

test('switching from one code to another shows only the second chest', async ({ page, request }) => {
	const first = await createChest(request, [{ content: 'FIRST CHEST TEXT', filename: 'first.txt' }]);
	const second = await createChest(request, [{ content: 'SECOND CHEST TEXT', filename: 'second.txt' }]);

	// Hold the first chest's response back so it arrives after the switch
	await page.route('**/api/retrieve', async (route) => {
		const body = route.request().postDataJSON() as { code: string };
		if (body.code === first.code) {
			await new Promise((resolve) => setTimeout(resolve, 1500));
		}
		await route.continue();
	});

	await page.goto(`/retrieve/#${first.code}`);
	// String form: this file is type-checked without the DOM lib
	await page.evaluate(
		`window.history.pushState({}, '', '/retrieve/#${second.code}'); window.dispatchEvent(new HashChangeEvent('hashchange'));`,
	);

	await expect(page.getByText('SECOND CHEST TEXT')).toBeVisible();
	await page.waitForTimeout(2000);
	await expect(page.getByText('FIRST CHEST TEXT')).toHaveCount(0);
	await expect(page.getByText('SECOND CHEST TEXT')).toBeVisible();
});

test('a malformed fragment shows a page without crashing', async ({ page }) => {
	const errors: string[] = [];
	page.on('pageerror', (err) => errors.push(err.message));
	await page.goto('/retrieve/#%ZZ');
	await expect(page.getByRole('heading', { name: 'Retrieve Files' })).toBeVisible();
	expect(errors).toEqual([]);
});

test('the old ?code= form is no longer used', async ({ page, request }) => {
	const chest = await createChest(request, [{ content: 'ignored', filename: 'x.txt' }]);
	const requests: string[] = [];
	page.on('request', (req) => requests.push(req.url()));

	await page.goto(`/retrieve/?code=${chest.code}`);
	await expect(page.getByRole('heading', { name: 'Retrieve Files' })).toBeVisible();
	expect(requests.some((url) => url.includes('/api/retrieve/'))).toBe(false);
	expect(requests.some((url) => url.endsWith('/api/retrieve'))).toBe(false);
});

// FIX-09: a permanent chest has no expiry date, and must not be shown as 1970
const permanentText: Record<string, RegExp> = { '': /never|permanent/i, ja: /無期限/, 'zh-Hant': /永久有效/ };
for (const [lang, pattern] of Object.entries(permanentText)) {
	test(`a permanent file share says so${lang ? ` (${lang})` : ''}`, async ({ page, request }) => {
		const chest = await createChest(request, [], { name: 'forever.txt', body: 'kept' }, -1);
		// String form: this file is type-checked without the DOM lib
		if (lang) await page.addInitScript(`window.localStorage.setItem('pocketchest.locale', '${lang}')`);
		await page.goto(`/retrieve/#${chest.code}`);
		await expect(page.getByText('forever.txt')).toBeVisible();

		await expect(page.getByText(pattern).first()).toBeVisible();
		const body = await page.locator('body').innerText();
		expect(body).not.toMatch(/1970|Invalid Date/);
	});
}
