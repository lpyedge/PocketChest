import { test, expect, Page } from '@playwright/test';
import { OWNER_PASSWORD, ORIGIN, ownerHeaders as ownerHeadersFor, randomClientIp, useClientAddress } from './owner';

// N2-05: leaving an app for the home page keeps the language, in every direction
const LANGS = [
	{
		lang: 'ja',
		home: '/ja/',
		browser: 'en-US',
		password: 'パスワード',
		signIn: 'パスワードでサインイン',
		homeHeading: /PocketChest/,
		back: /ホームへ/,
	},
	{
		lang: 'en',
		home: '/en/',
		browser: 'ja-JP',
		password: 'Password',
		signIn: 'Sign in with password',
		homeHeading: /PocketChest/,
		back: /Back to Home/,
	},
	{ lang: 'zh-Hant', home: '/', browser: 'en-US', password: '密碼', signIn: '以密碼登入', homeHeading: /PocketChest/, back: /回到首頁/ },
];

async function clearOnce(page: Page) {
	await page.addInitScript(
		`if (!window.sessionStorage.getItem('cleared')) { window.localStorage.clear(); window.sessionStorage.setItem('cleared', '1'); }`,
	);
}

for (const c of LANGS) {
	test.describe(`${c.lang} (browser ${c.browser})`, () => {
		test.use({ locale: c.browser });

		test('T10: home → upload → home', async ({ page }) => {
			await useClientAddress(page, randomClientIp());
			await clearOnce(page);
			await page.goto(c.home);
			await page.locator('a[href^="/upload/"]').click();
			await expect.poll(() => page.getAttribute('html', 'lang')).toBe(c.lang);

			const back = page.getByRole('link', { name: c.back });
			await expect(back).toBeVisible();
			await back.click();

			await expect(page).toHaveURL(new RegExp(`${c.home === '/' ? '/$' : c.home.replace(/\//g, '\\/') + '$'}`));
			expect(await page.getAttribute('html', 'lang')).toBe(c.lang);
		});

		test('T11: home → retrieve (with a code) → failure page → home', async ({ page }) => {
			await useClientAddress(page, randomClientIp());
			await clearOnce(page);
			await page.goto(c.home);
			await page.locator('a[href^="/retrieve/"]').click();
			await page.evaluate(`window.location.hash = '#ZZZZZZ'; window.dispatchEvent(new HashChangeEvent('hashchange'));`);
			// The code does not exist: the failure page has its own way home
			const home = page.getByRole('button', { name: /^(Go Home|ホームへ|回到首頁)$/ });
			await expect(home).toBeVisible();
			await expect.poll(() => page.getAttribute('html', 'lang')).toBe(c.lang);
			expect(new URL(page.url()).hash).toBe('#ZZZZZZ');

			await home.click();
			await expect(page).toHaveURL(new RegExp(`${c.home === '/' ? '/$' : c.home.replace(/\//g, '\\/') + '$'}`));
			expect(await page.getAttribute('html', 'lang')).toBe(c.lang);
		});

		test('sign-in page and upload-success page also lead home in the same language, with no English left over', async ({
			page,
			request,
		}) => {
			await useClientAddress(page, randomClientIp());
			await request.get('/api/auth/methods');
			await clearOnce(page);
			await page.goto(`/upload/?lang=${c.lang}`);
			if (c.lang !== 'en') {
				// Nothing on the sign-in page is still the English default
				expect(await page.locator('body').innerText()).not.toMatch(/Back to Home/);
			}
			await expect(page.getByRole('link', { name: c.back }).first()).toHaveAttribute('href', c.home);

			await page.getByLabel(c.password, { exact: true }).fill(OWNER_PASSWORD);
			await page.getByRole('button', { name: c.signIn }).click();
			await page.locator('textarea').first().fill('hello');
			await page
				.getByRole('button')
				.filter({ hasText: /Add Text|テキストを追加|加入文字/ })
				.click();
			await page
				.getByRole('button')
				.filter({ hasText: /Upload & Generate Code|アップロードしてコードを作成|上傳並產生取件碼/ })
				.click();
			await expect(page.locator('code').filter({ hasText: '/retrieve/#' }).first()).toBeVisible();

			if (c.lang !== 'en') expect(await page.locator('body').innerText()).not.toMatch(/Back to Home/);
			// The page offers the way home twice (top and bottom); both go to the same place
			const homes = page.getByRole('link', { name: c.back });
			for (const link of await homes.all()) await expect(link).toHaveAttribute('href', c.home);
			const home = homes.first();
			await home.click();
			expect(await page.getAttribute('html', 'lang')).toBe(c.lang);
		});
	});
}

test.describe('language switching inside a page', () => {
	test.use({ locale: 'en-US' });

	test('T12: a language file that fails to download changes nothing that is kept', async ({ page }) => {
		await useClientAddress(page, randomClientIp());
		await clearOnce(page);
		await page.goto('/retrieve/?lang=en');
		await expect(page.getByRole('heading', { name: 'Retrieve Files' })).toBeVisible();

		let jaRequests = 0;
		await page.route('**/assets/ja-*.js', (route) => {
			jaRequests++;
			return route.fulfill({ status: 503, body: 'unavailable' });
		});
		await page.getByRole('combobox').selectOption('ja');
		await expect.poll(() => jaRequests).toBeGreaterThan(0);

		// Still English, in the page, the address and the stored choice
		await expect(page.getByRole('heading', { name: 'Retrieve Files' })).toBeVisible();
		await expect.poll(() => page.getAttribute('html', 'lang')).toBe('en');
		expect(new URL(page.url()).searchParams.get('lang')).toBe('en');
		expect(await page.evaluate(`window.localStorage.getItem('pocketchest.locale')`)).not.toBe('ja');
		const before = jaRequests;

		await page.reload();
		await expect(page.getByRole('heading', { name: 'Retrieve Files' })).toBeVisible();
		expect(jaRequests).toBe(before);

		// Once the network recovers, the switch works and is kept
		await page.unroute('**/assets/ja-*.js');
		await page.getByRole('combobox').selectOption('ja');
		await expect.poll(() => page.getAttribute('html', 'lang')).toBe('ja');
		expect(new URL(page.url()).searchParams.get('lang')).toBe('ja');
		expect(await page.evaluate(`window.localStorage.getItem('pocketchest.locale')`)).toBe('ja');
	});

	test('T13: the language can be switched on the page that shows the files, without losing them', async ({ page, request }) => {
		const clientIp = randomClientIp();
		await useClientAddress(page, clientIp);
		await clearOnce(page);
		const session = await (
			await request.post('/api/upload-sessions', { headers: await ownerHeadersFor(request, clientIp), data: {} })
		).json();
		const headers = { Authorization: `Bearer ${session.uploadToken}`, 'CF-Connecting-IP': clientIp };
		const uploaded = await (
			await request.post(`/api/upload-sessions/${session.sessionId}/files`, {
				headers,
				multipart: { files: { name: 'keep.txt', mimeType: 'text/plain', buffer: Buffer.from('kept') } },
			})
		).json();
		const done = await (
			await request.post(`/api/upload-sessions/${session.sessionId}/complete`, {
				headers,
				data: { fileIds: [uploaded.uploadedFiles[0].fileId], validityDays: 7 },
			})
		).json();

		await page.goto(`/retrieve/?lang=en#${done.retrievalCode}`);
		await expect(page.getByText('keep.txt')).toBeVisible();
		await page.evaluate('window.marker = 7');

		await page.getByRole('combobox').selectOption('ja');

		await expect.poll(() => page.getAttribute('html', 'lang')).toBe('ja');
		await expect(page.getByText('keep.txt')).toBeVisible();
		await expect(page.getByText(done.retrievalCode, { exact: true })).toBeVisible();
		await expect(page.getByText(/取り出しコード/).first()).toBeVisible();
		expect(await page.evaluate('window.marker')).toBe(7);
		expect(new URL(page.url()).hash).toBe(`#${done.retrievalCode}`);
	});
});
