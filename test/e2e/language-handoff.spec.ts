import { test, expect } from '@playwright/test';
import { randomClientIp, useClientAddress } from './owner';

// R07: the language chosen on a static home page must follow the visitor into the app,
// whatever the browser itself prefers
const CASES = [
	{
		home: '/ja/',
		browser: 'en-US',
		lang: 'ja',
		uploadHeading: /ファイルとテキストを共有|サインイン/,
		retrieveHeading: /ファイルを取り出す|取り出し/,
	},
	{ home: '/en/', browser: 'ja-JP', lang: 'en', uploadHeading: /Share Files|Sign in/, retrieveHeading: /Retrieve Files/ },
	{ home: '/', browser: 'en-US', lang: 'zh-Hant', uploadHeading: /分享檔案|登入/, retrieveHeading: /取回檔案|取件/ },
];

for (const c of CASES) {
	test.describe(`${c.home} opened by a ${c.browser} browser`, () => {
		test.use({ locale: c.browser });

		test('keeps its language on the upload and retrieve pages, and after a reload', async ({ page }) => {
			await useClientAddress(page, randomClientIp());
			await page.addInitScript(`window.localStorage.clear()`);
			await page.goto(c.home);
			expect(await page.getAttribute('html', 'lang')).toBe(c.lang);

			await page.locator('a[href^="/upload/"]').click();
			await expect(page).toHaveURL(/\/upload\/\?lang=/);
			await expect.poll(() => page.getAttribute('html', 'lang')).toBe(c.lang);
			await expect(page.getByRole('heading').first()).toContainText(c.uploadHeading);

			await page.reload();
			expect(await page.getAttribute('html', 'lang')).toBe(c.lang);

			await page.goto(c.home);
			await page.locator('a[href^="/retrieve/"]').click();
			await expect(page).toHaveURL(/\/retrieve\/\?lang=/);
			await expect.poll(() => page.getAttribute('html', 'lang')).toBe(c.lang);
			await expect(page.getByRole('heading').first()).toContainText(c.retrieveHeading);
		});
	});
}

test('a share link stays /retrieve/#CODE, and a code in the hash still works next to ?lang=', async ({ page }) => {
	await useClientAddress(page, randomClientIp());
	await page.goto('/retrieve/?lang=ja#ABC123');
	await expect.poll(() => page.getAttribute('html', 'lang')).toBe('ja');
	expect(new URL(page.url()).hash).toBe('#ABC123');
	// The code was read from the fragment: the lookup is made, and the unknown code is reported in Japanese
	await expect(page.getByText(/見つかりません|期限切れ|無効/).first()).toBeVisible();
});

test('an unsupported ?lang= is ignored', async ({ page }) => {
	await useClientAddress(page, randomClientIp());
	await page.addInitScript(`window.localStorage.clear()`);
	await page.goto('/retrieve/?lang=klingon');
	expect(await page.getAttribute('html', 'lang')).toBe('en');
});

// C21: a language file that cannot be downloaded must not leave a blank page
test.describe('language file failure', () => {
	test.use({ locale: 'ja-JP' });

	test('shows a retry page, and retrying after the network recovers loads the app', async ({ page }) => {
		await useClientAddress(page, randomClientIp());
		// Clear storage once only: the page is reloaded during the test and must keep what it stored
		await page.addInitScript(
			`if (!window.sessionStorage.getItem('cleared')) { window.localStorage.clear(); window.sessionStorage.setItem('cleared', '1'); }`,
		);
		await page.route('**/assets/ja-*.js', (route) => route.fulfill({ status: 503, body: 'unavailable' }));

		await page.goto('/retrieve/');
		const alert = page.getByRole('alert');
		await expect(alert).toBeVisible();
		await expect(alert).toContainText('Retry');
		expect((await page.locator('body').innerText()).trim().length).toBeGreaterThan(20);

		await page.unroute('**/assets/ja-*.js');
		await alert.getByRole('button', { name: /Retry/ }).click();
		await expect(page.getByRole('heading').first()).toContainText(/ファイルを取り出す|取り出し/);
		expect(await page.getAttribute('html', 'lang')).toBe('ja');
	});

	test('offers English when the Japanese file keeps failing', async ({ page }) => {
		await useClientAddress(page, randomClientIp());
		// Clear storage once only: the page is reloaded during the test and must keep what it stored
		await page.addInitScript(
			`if (!window.sessionStorage.getItem('cleared')) { window.localStorage.clear(); window.sessionStorage.setItem('cleared', '1'); }`,
		);
		await page.route('**/assets/ja-*.js', (route) => route.fulfill({ status: 503, body: 'unavailable' }));

		await page.goto('/retrieve/?lang=ja');
		await page.getByRole('alert').getByRole('button', { name: 'English' }).click();

		await expect(page.getByRole('heading').first()).toContainText(/Retrieve Files/);
		expect(await page.getAttribute('html', 'lang')).toBe('en');
	});
});
