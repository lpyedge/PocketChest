import { test, expect, Page } from '@playwright/test';
import { ORIGIN, OWNER_PASSWORD, randomClientIp, useClientAddress } from './owner';

test.use({ locale: 'en-US' });

async function signIn(page: Page, request: import('@playwright/test').APIRequestContext) {
	await useClientAddress(page, randomClientIp());
	await request.get('/api/auth/methods');
	await page.goto('/upload/?lang=en');
	await page.getByLabel('Password', { exact: true }).fill(OWNER_PASSWORD);
	await page.getByRole('button', { name: 'Sign in with password' }).click();
}

async function makeShare(page: Page, text: string) {
	await page.locator('textarea').first().fill(text);
	await page.getByRole('button', { name: 'Add Text' }).click();
	await page.getByRole('button', { name: 'Upload & Generate Code' }).click();
	await expect(page.locator('code').filter({ hasText: '/retrieve/#' }).first()).toBeVisible();
}

const rows = (page: Page) => page.getByTestId('share-row');
const noHorizontalScroll = (page: Page) =>
	page.evaluate(() => {
		const root = (globalThis as any).document.documentElement;
		return root.scrollWidth <= root.clientWidth;
	});

test('share records are reachable from the upload page and from the result page', async ({ page, request }) => {
	await signIn(page, request);
	await expect(page.getByRole('button', { name: 'Share records' })).toBeVisible();
	await makeShare(page, 'entry check');
	await expect(page.getByRole('button', { name: 'Share records' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Security settings' })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
	// The copy and share actions of the result stay in place
	await expect(page.getByRole('button', { name: /Copy/ }).first()).toBeVisible();
});

test('signed out, there is no share record entry', async ({ page }) => {
	await useClientAddress(page, randomClientIp());
	await page.goto('/upload/?lang=en');
	await expect(page.getByRole('button', { name: 'Share records' })).toHaveCount(0);
	const response = await page.request.get('/api/admin/shares');
	expect(response.status()).toBe(401);
});

test('create, list, extend, revoke: the recipient is refused afterwards', async ({ page, request, context }) => {
	await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => undefined);
	await signIn(page, request);
	page.on('dialog', (dialog) => dialog.accept());
	await makeShare(page, 'manage me');
	const link = (await page.locator('code').filter({ hasText: '/retrieve/#' }).first().innerText()).trim();
	const code = link.split('#')[1];

	await page.getByRole('button', { name: 'Share records' }).click();
	const dialog = page.getByRole('dialog', { name: 'Share records' });
	await expect(dialog).toBeVisible();
	const row = rows(page).filter({ hasText: code });
	await expect(row).toBeVisible();
	await expect(row).toContainText('Expires');

	// Extend to permanent
	await row.getByLabel('Extend until').selectOption('-1');
	await row.getByRole('button', { name: 'Extend', exact: true }).click();
	await expect(dialog.getByText('Expiry updated.')).toBeVisible();
	await expect(row).toContainText('never');

	// Shortening is refused with a message, not silently ignored
	await row.getByLabel('Extend until').selectOption('3');
	await row.getByRole('button', { name: 'Extend', exact: true }).click();
	await expect(dialog.getByRole('alert')).toBeVisible();

	// The recipient can still retrieve before revoking
	const before = await request.post('/api/retrieve', { data: { code } });
	expect(before.status()).toBe(200);

	await row.getByRole('button', { name: 'Revoke' }).click();
	await expect(dialog.getByText(/Share revoked/)).toBeVisible();
	await expect(rows(page).filter({ hasText: code })).toHaveCount(0);

	const after = await request.post('/api/retrieve', { data: { code } });
	expect(after.status()).toBe(404);
});

test('the dialog is usable by keyboard and fits a phone', async ({ page, request }) => {
	await signIn(page, request);
	const opener = page.getByRole('button', { name: 'Share records' });
	await opener.click();
	const dialog = page.getByRole('dialog', { name: 'Share records' });
	await expect(dialog).toBeVisible();
	await expect(dialog.locator(':focus')).toHaveCount(1);
	for (let i = 0; i < 6; i++) await page.keyboard.press('Tab');
	await expect(dialog.locator(':focus')).toHaveCount(1);
	expect(await noHorizontalScroll(page)).toBe(true);
	await page.keyboard.press('Escape');
	await expect(dialog).toHaveCount(0);
	await expect(opener).toBeFocused();
});

test('an empty list says so', async ({ page, request }) => {
	await signIn(page, request);
	await page.getByRole('button', { name: 'Share records' }).click();
	const dialog = page.getByRole('dialog', { name: 'Share records' });
	// Other tests may have left shares: revoke whatever is listed so the empty state is real
	page.on('dialog', (d) => d.accept());
	const empty = dialog.getByText('No active shares.');
	for (let guard = 0; guard < 200 && !(await empty.isVisible()); guard++) {
		const first = rows(page).first();
		if (await first.isVisible()) {
			const code = (await first.locator('code').innerText()).trim();
			await first.getByRole('button', { name: 'Revoke' }).click();
			await expect(rows(page).filter({ hasText: code })).toHaveCount(0);
		} else {
			await page.waitForTimeout(100);
		}
	}
	await expect(dialog.getByText('No active shares.')).toBeVisible();
});
