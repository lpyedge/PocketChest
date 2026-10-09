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
