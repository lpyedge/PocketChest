import { test, expect } from '@playwright/test';
import { OWNER_PASSWORD, ORIGIN, randomClientIp, useClientAddress } from './owner';

interface Language {
	name: string;
	locale: string;
	lang: string;
	passwordLabel: string;
	signIn: string;
	uploadTitle: string;
	submit: string;
	addText: string;
	copyMessage: string;
	// The wording around the retrieval page address and code
	message: (page: string, code: string) => string;
	textPlaceholderStart: string;
	retrieveHeading: string;
	languageOption: string;
}

const LANGUAGES: Language[] = [
	{
		name: 'Japanese',
		locale: 'ja-JP',
		lang: 'ja',
		passwordLabel: 'パスワード',
		signIn: 'パスワードでサインイン',
		uploadTitle: '📤 ファイルとテキストを共有',
		submit: 'アップロードしてコードを作成',
		addText: 'テキストを追加',
		copyMessage: 'メッセージとしてコピー',
		message: (page, code) => `${page} を開き、取り出しコード「${code}」を入力してください。`,
		textPlaceholderStart: 'テキスト、コードの断片',
		retrieveHeading: '📝 テキスト',
		languageOption: '日本語',
	},
	{
		name: 'Traditional Chinese',
		locale: 'zh-TW',
		lang: 'zh-Hant',
		passwordLabel: '密碼',
		signIn: '以密碼登入',
		uploadTitle: '📤 分享檔案與文字',
		submit: '上傳並產生取件碼',
		addText: '加入文字',
		copyMessage: '複製為訊息',
		message: (page, code) => `請開啟 ${page}，輸入取件碼 ${code} 取得分享的檔案。`,
		textPlaceholderStart: '輸入文字',
		retrieveHeading: '📝 文字內容',
		languageOption: '繁體中文',
	},
	{
		name: 'English',
		locale: 'en-US',
		lang: 'en',
		passwordLabel: 'Password',
		signIn: 'Sign in with password',
		uploadTitle: '📤 Share Files & Text',
		submit: 'Upload & Generate Code',
		addText: 'Add Text',
		copyMessage: 'Copy as message',
		message: (page, code) => `Open ${page} and enter retrieval code ${code} to access the shared files.`,
		textPlaceholderStart: 'Enter text content',
		retrieveHeading: '📝 Text Content',
		languageOption: 'English',
	},
];

for (const language of LANGUAGES) {
	test.describe(`${language.name} (${language.locale})`, () => {
		test.use({ locale: language.locale, permissions: ['clipboard-read', 'clipboard-write'] });

		test('signs in, uploads text, and retrieves it, in one language', async ({ page, request }) => {
			await useClientAddress(page, randomClientIp());
			const consoleErrors: string[] = [];
			page.on('console', (message) => {
				if (message.type() === 'error') consoleErrors.push(message.text());
			});
			await request.post('/api/auth/bootstrap', { headers: { Origin: ORIGIN }, data: { password: OWNER_PASSWORD } });

			await page.goto('/upload/');
			expect(await page.getAttribute('html', 'lang')).toBe(language.lang);
			await expect(page.getByLabel(language.passwordLabel, { exact: true })).toBeVisible();
			await page.getByLabel(language.passwordLabel, { exact: true }).fill(OWNER_PASSWORD);
			await page.getByRole('button', { name: language.signIn }).click();

			await expect(page.getByRole('heading', { level: 1, name: language.uploadTitle })).toBeVisible();
			await page.locator('textarea').first().fill(`hello in ${language.lang}`);
			await page.getByRole('button', { name: language.addText }).click();
			await page.getByRole('button', { name: language.submit }).click();

			const link = page.locator('code').filter({ hasText: '/retrieve/#' }).first();
			await expect(link).toBeVisible();
			const shareUrl = (await link.textContent()) ?? '';
			expect(shareUrl).toMatch(/\/retrieve\/#[A-Z0-9]{6}$/);

			// The copied message is written in the current language and gives the retrieval page and the code
			// separately; it does not carry the #CODE form of the direct link
			await page.getByRole('button', { name: language.copyMessage }).click();
			const message = (await page.evaluate('navigator.clipboard.readText()')) as string;
			const code = shareUrl.slice(-6);
			const retrievePage = shareUrl.slice(0, shareUrl.indexOf('#'));
			expect(retrievePage).toMatch(/\/retrieve\/$/);
			expect(message).toBe(language.message(retrievePage, code));
			expect(message).not.toContain('#');

			// The direct-link button still copies the plain /retrieve/#CODE link
			await page
				.getByRole('button', { name: /^(Copy|コピー|複製)$/ })
				.first()
				.click();
			expect(await page.evaluate('navigator.clipboard.readText()')).toBe(shareUrl);

			await page.goto(shareUrl);
			await expect(page.getByRole('heading', { level: 2, name: language.retrieveHeading })).toBeVisible();
			await expect(page.getByText(`hello in ${language.lang}`)).toBeVisible();

			// Nothing overflows the viewport; the mobile project checks this at 375px
			expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
			expect(consoleErrors).toEqual([]);
		});

		test('switches language in place and keeps the choice after a reload', async ({ page }) => {
			await useClientAddress(page, randomClientIp());
			await page.goto('/retrieve/');
			await page.evaluate('window.marker = 42');

			await page.getByRole('combobox').selectOption('en');
			expect(await page.getAttribute('html', 'lang')).toBe('en');
			expect(await page.evaluate('window.marker')).toBe(42);

			await page.reload();
			expect(await page.getAttribute('html', 'lang')).toBe('en');
		});
	});
}

test('ignores an unsupported stored language and falls back to the browser language', async ({ page }) => {
	await useClientAddress(page, randomClientIp());
	await page.addInitScript("window.localStorage.setItem('pocketchest.locale', 'klingon')");
	await page.goto('/retrieve/');
	expect(await page.getAttribute('html', 'lang')).toBe('en');
});

test('loads only the chunk for the language in use', async ({ page }) => {
	await useClientAddress(page, randomClientIp());
	const scripts: string[] = [];
	page.on('response', (response) => {
		if (response.url().includes('/assets/') && response.url().endsWith('.js')) scripts.push(response.url());
	});
	await page.goto('/retrieve/');
	await expect(page.getByRole('combobox')).toBeVisible();
	// The browser in this project asks for English, so only the English language file is downloaded
	expect(scripts.some((url) => /\/assets\/en-/.test(url))).toBe(true);
	expect(scripts.some((url) => /\/assets\/ja-/.test(url))).toBe(false);
	expect(scripts.some((url) => /\/assets\/zh-Hant-/.test(url))).toBe(false);
});
