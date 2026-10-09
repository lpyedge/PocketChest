import { test, expect } from '@playwright/test';

// Smoke checks for the three entry points, on desktop and at 375px width
const pages = [
	{ path: '/', heading: 'PocketChest' },
	{ path: '/upload/', heading: 'Share Files & Text' },
	{ path: '/retrieve/', heading: 'Retrieve Files' },
];

for (const { path, heading } of pages) {
	test(`${path} renders its heading`, async ({ page }) => {
		await page.goto(path);
		await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible();
	});

	test(`${path} has no horizontal overflow`, async ({ page }) => {
		await page.goto(path);
		await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible();
		// String form: this file is type-checked against the Worker runtime, which has no DOM lib
		const overflow = await page.evaluate<number>('document.documentElement.scrollWidth - document.documentElement.clientWidth');
		expect(overflow).toBeLessThanOrEqual(0);
	});
}

test('home page links to both applications', async ({ page }) => {
	await page.goto('/');
	await expect(page.getByRole('link', { name: /分享檔案/ })).toHaveAttribute('href', '/upload/');
	await expect(page.getByRole('link', { name: /取回檔案/ })).toHaveAttribute('href', '/retrieve/');
});

test('home page ships no application script', async ({ request }) => {
	const html = await (await request.get('/')).text();
	expect(html).not.toMatch(/<script[^>]+type="module"/);
});
