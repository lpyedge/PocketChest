import { test, expect, Page } from '@playwright/test';
import { OWNER_PASSWORD, ORIGIN, randomClientIp, useClientAddress } from './owner';

// N2-07: cancelling and completing must never contradict each other on screen
test.use({ locale: 'en-US' });

async function openUploadPage(page: Page, request: import('@playwright/test').APIRequestContext) {
	await useClientAddress(page, randomClientIp());
	await request.post('/api/auth/bootstrap', { headers: { Origin: ORIGIN }, data: { password: OWNER_PASSWORD } });
	await page.goto('/upload/?lang=en');
	await page.getByLabel('Password', { exact: true }).fill(OWNER_PASSWORD);
	await page.getByRole('button', { name: 'Sign in with password' }).click();
	await page.locator('textarea').first().fill('some text');
	await page.getByRole('button', { name: 'Add Text' }).click();
}

const submit = (page: Page) => page.getByRole('button', { name: 'Upload & Generate Code' });

test('N2-T14: while the share is being completed there is no Cancel to press, and the result arrives', async ({ page, request }) => {
	await openUploadPage(page, request);
	await page.route('**/complete', async (route) => {
		await new Promise((resolve) => setTimeout(resolve, 1200));
		await route.continue();
	});

	await submit(page).click();
	await expect(page.getByText('Finishing…')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Cancel' })).toHaveCount(0);

	await expect(page.locator('code').filter({ hasText: '/retrieve/#' }).first()).toBeVisible();
});

test('N2-T14: Cancel is only shown as done after the server has confirmed it', async ({ page, request }) => {
	await openUploadPage(page, request);
	await page.route('**/files', async (route) => {
		await new Promise((resolve) => setTimeout(resolve, 3000));
		await route.continue().catch(() => undefined);
	});
	let release: () => void = () => undefined;
	const held = new Promise<void>((resolve) => (release = resolve));
	await page.route('**/cancel', async (route) => {
		await held;
		await route.continue();
	});

	await submit(page).click();
	await page.getByRole('button', { name: 'Cancel' }).click();

	// The server has not answered yet: the page says it is cancelling, not that it is cancelled
	await expect(page.getByText('Cancelling…')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
	release();
	await expect(page.getByText('Cancelling…')).toHaveCount(0);
	await expect(submit(page)).toBeVisible();
});

test('N2-T14: a cancel the server refuses is reported, not shown as a success', async ({ page, request }) => {
	await openUploadPage(page, request);
	await page.route('**/files', async (route) => {
		await new Promise((resolve) => setTimeout(resolve, 3000));
		await route.continue().catch(() => undefined);
	});
	await page.route('**/cancel', (route) =>
		route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: 'CONFLICT', error: 'busy' }) }),
	);

	await submit(page).click();
	await page.getByRole('button', { name: 'Cancel' }).click();

	await expect(page.getByText(/could not be cancelled/i).first()).toBeVisible();
	await expect(page.getByRole('button', { name: /Retry Upload/ })).toBeVisible();
});

test('N2-T14: when the answer to Complete is lost, Retry asks again for the same session and gets the one share', async ({
	page,
	request,
}) => {
	await openUploadPage(page, request);
	let sessions = 0;
	let fileUploads = 0;
	let completes = 0;
	page.on('request', (req) => {
		if (req.method() !== 'POST') return;
		if (req.url().endsWith('/api/upload-sessions')) sessions++;
		if (req.url().endsWith('/files')) fileUploads++;
		if (req.url().endsWith('/complete')) completes++;
	});
	// The first Complete reaches the server and succeeds, but the answer never gets back to the page
	let first = true;
	await page.route('**/complete', async (route) => {
		if (first) {
			first = false;
			await route.fetch();
			await route.abort('connectionreset');
			return;
		}
		await route.continue();
	});

	await submit(page).click();
	await expect(page.getByRole('button', { name: /Retry Upload/ })).toBeVisible();
	await page.getByRole('button', { name: /Retry Upload/ }).click();

	const link = page.locator('code').filter({ hasText: '/retrieve/#' }).first();
	await expect(link).toBeVisible();
	expect(sessions).toBe(1);
	expect(fileUploads).toBe(1);
	expect(completes).toBe(2);
});
