import { test, expect } from '@playwright/test';

// The three home pages are plain HTML: they must read and navigate with JavaScript turned off
test.describe('static home pages without JavaScript', () => {
	test.use({ javaScriptEnabled: false });

	const homes = [
		{ path: '/', lang: 'zh-Hant', heading: '分享檔案' },
		{ path: '/ja/', lang: 'ja', heading: 'ファイルを共有' },
		{ path: '/en/', lang: 'en', heading: 'Share Files' },
	];

	for (const home of homes) {
		test(`${home.path} is readable and contains no application script`, async ({ page }) => {
			const requested: string[] = [];
			page.on('request', (request) => requested.push(new URL(request.url()).pathname));

			await page.goto(home.path);
			expect(await page.getAttribute('html', 'lang')).toBe(home.lang);
			await expect(page.getByRole('heading', { level: 1, name: 'PocketChest' })).toBeVisible();
			await expect(page.getByRole('heading', { level: 2, name: home.heading })).toBeVisible();
			expect(await page.locator('script').count()).toBe(0);
			expect(requested.filter((path) => path.endsWith('.js'))).toEqual([]);
		});
	}

	test('the language links move between the three home pages without JavaScript', async ({ page }) => {
		await page.goto('/');
		await page.getByRole('link', { name: '日本語' }).click();
		await expect(page).toHaveURL(/\/ja\/$/);
		await expect(page.getByRole('heading', { level: 2, name: 'ファイルを共有' })).toBeVisible();

		await page.getByRole('link', { name: 'English' }).click();
		await expect(page).toHaveURL(/\/en\/$/);
		await expect(page.getByRole('heading', { level: 2, name: 'Share Files' })).toBeVisible();
	});

	test('the page links to the upload and retrieve applications', async ({ page }) => {
		await page.goto('/en/');
		const upload = await page.request.get('/upload/');
		const retrieve = await page.request.get('/retrieve/');
		expect(upload.status()).toBe(200);
		expect(retrieve.status()).toBe(200);
		await expect(page.getByRole('link', { name: /Start Sharing/ })).toHaveAttribute('href', '/upload/?lang=en');
		await expect(page.getByRole('link', { name: /Enter Code/ })).toHaveAttribute('href', '/retrieve/?lang=en');
	});

	test('an unknown path gets the 404 page, not the home page', async ({ page }) => {
		const response = await page.goto('/no-such-page/');
		expect(response?.status()).toBe(404);
	});
});

// The footer must describe the service as it is: guests retrieve without signing in, uploading needs the owner,
// and only time-limited shares expire
const FOOTERS: [string, string][] = [
	['/', '訪客取件不需登入；上傳需管理員登入。有期限的分享會在到期後清除。'],
	['/ja/', '受け取りにログインは不要です。アップロードには管理者のサインインが必要です。期限付きの共有は有効期限後に削除されます。'],
	[
		'/en/',
		'Recipients can retrieve files without signing in. Uploading requires owner sign-in. Time-limited shares are deleted after they expire.',
	],
];
for (const [path, footer] of FOOTERS) {
	test(`${path} footer is accurate about sign-in and expiry`, async ({ page }) => {
		await page.goto(path);
		await expect(page.getByText(footer)).toBeVisible();
		await expect(page.getByText(/No account required|アカウントは不要|無需帳號/)).toHaveCount(0);
	});
}
