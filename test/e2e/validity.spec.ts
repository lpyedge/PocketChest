import { test, expect } from '@playwright/test';
import { OWNER_PASSWORD, ORIGIN, randomClientIp, useClientAddress } from './owner';

const LANGUAGES = [
	{
		locale: 'ja-JP',
		password: 'パスワード',
		signIn: 'パスワードでサインイン',
		addText: 'テキストを追加',
		submit: 'アップロードしてコードを作成',
		twoWeeks: /^2週間/,
	},
	{ locale: 'zh-TW', password: '密碼', signIn: '以密碼登入', addText: '加入文字', submit: '上傳並產生取件碼', twoWeeks: /^2 週/ },
	{
		locale: 'en-US',
		password: 'Password',
		signIn: 'Sign in with password',
		addText: 'Add Text',
		submit: 'Upload & Generate Code',
		twoWeeks: /^2 Weeks/,
	},
];

// R04: the "2 weeks" choice must really mean 14 days, in every language
for (const language of LANGUAGES) {
	test.describe(language.locale, () => {
		test.use({ locale: language.locale });

		test('the two-week option sends 14 and the share expires 14 days later', async ({ page, request }) => {
			const clientIp = randomClientIp();
			await useClientAddress(page, clientIp);
			await request.get('/api/auth/methods');

			await page.goto('/upload/');
			await page.getByLabel(language.password, { exact: true }).fill(OWNER_PASSWORD);
			await page.getByRole('button', { name: language.signIn }).click();
			await page.locator('textarea').first().fill('two weeks');
			await page.getByRole('button', { name: language.addText }).click();
			await page.getByRole('button', { name: language.twoWeeks }).click();

			const completing = page.waitForRequest((req) => req.url().endsWith('/complete') && req.method() === 'POST');
			const started = Date.now() / 1000;
			await page.getByRole('button', { name: language.submit }).click();
			const sent = (await completing).postDataJSON() as { validityDays: number };
			expect(sent.validityDays).toBe(14);

			const link = page.locator('code').filter({ hasText: '/retrieve/#' }).first();
			const code = ((await link.textContent()) ?? '').slice(-6);
			const retrieved = await request.post('/api/retrieve', { headers: { 'CF-Connecting-IP': clientIp }, data: { code } });
			const { expiryDate } = (await retrieved.json()) as { expiryDate: string };
			const seconds = Date.parse(expiryDate) / 1000 - started;
			expect(seconds).toBeGreaterThan(14 * 86400 - 60);
			expect(seconds).toBeLessThan(14 * 86400 + 60);
		});
	});
}
