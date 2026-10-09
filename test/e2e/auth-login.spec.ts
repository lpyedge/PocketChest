import { test, expect, Page } from '@playwright/test';
import { ORIGIN, OWNER_PASSWORD, randomClientIp, useClientAddress } from './owner';

test.beforeEach(async ({ page }) => {
	await useClientAddress(page, randomClientIp());
});

// Describes which sign-in methods the page is told are available; the server is not involved
async function withMethods(page: Page, methods: { setupRequired: boolean; password: boolean; totp: boolean; passkey: boolean }) {
	await page.route('**/api/auth/session', (route) => route.fulfill({ json: { authenticated: false } }));
	await page.route('**/api/auth/methods', (route) =>
		route.fulfill({
			json: {
				setupRequired: methods.setupRequired,
				methods: { password: { enabled: methods.password }, totp: { enabled: methods.totp }, passkey: { enabled: methods.passkey } },
			},
		}),
	);
}

test('shows only the password form when only the password is switched on', async ({ page }) => {
	await withMethods(page, { setupRequired: false, password: true, totp: false, passkey: false });
	await page.goto('/upload/');

	await expect(page.getByRole('button', { name: 'Sign in with password' })).toBeVisible();
	await expect(page.getByLabel('Authenticator code')).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Sign in with passkey' })).toHaveCount(0);
});

test('shows only the authenticator form when only the authenticator is switched on', async ({ page }) => {
	await withMethods(page, { setupRequired: false, password: false, totp: true, passkey: false });
	await page.goto('/upload/');

	await expect(page.getByLabel('Authenticator code')).toBeVisible();
	await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
	await expect(page.getByRole('button', { name: 'Sign in with passkey' })).toHaveCount(0);
});

test('shows only the passkey button when only the passkey is switched on', async ({ page }) => {
	await withMethods(page, { setupRequired: false, password: false, totp: false, passkey: true });
	await page.goto('/upload/');

	await expect(page.getByRole('button', { name: 'Sign in with passkey' })).toBeVisible();
	await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
	await expect(page.getByLabel('Authenticator code')).toHaveCount(0);
});

test('offers the setup form on a fresh deployment, and no upload form', async ({ page }) => {
	await withMethods(page, { setupRequired: true, password: false, totp: false, passkey: false });
	await page.goto('/upload/');

	await expect(page.getByText('First-time setup')).toBeVisible();
	await expect(page.getByLabel('Administrator password')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Share Files & Text' })).toHaveCount(0);
});

test('fails closed when nothing is switched on, and never shows an upload form', async ({ page }) => {
	await withMethods(page, { setupRequired: false, password: false, totp: false, passkey: false });
	await page.goto('/upload/');

	await expect(page.getByText('No sign-in method is available on this page')).toBeVisible();
	await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
	await expect(page.getByText('Upload files or text to get a shareable code')).toHaveCount(0);
});

test('shows how long to wait after a lockout, instead of a blank page', async ({ page }) => {
	await withMethods(page, { setupRequired: false, password: true, totp: false, passkey: false });
	await page.route('**/api/auth/login/password', (route) =>
		route.fulfill({
			status: 429,
			headers: { 'Retry-After': '42', 'Content-Type': 'application/json' },
			json: { error: 'Too many failed attempts; try again later', code: 'AUTH_TEMPORARILY_LOCKED' },
		}),
	);
	await page.goto('/upload/');
	await page.getByLabel('Password', { exact: true }).fill('anything-at-all');
	await page.getByRole('button', { name: 'Sign in with password' }).click();

	await expect(page.getByText('Try again in 42 seconds.')).toBeVisible();
	await expect(page.getByRole('button', { name: 'Sign in with password' })).toBeVisible();
});

test('signs in with the real owner password and reaches the upload form', async ({ page, request }) => {
	// Claims the owner on a fresh bucket; later runs get 409 because the owner already exists
	await request.post('/api/auth/bootstrap', { headers: { Origin: ORIGIN }, data: { password: OWNER_PASSWORD } });
	await page.goto('/upload/');

	await page.getByLabel('Password', { exact: true }).fill('not-the-password-at-all');
	await page.getByRole('button', { name: 'Sign in with password' }).click();
	await expect(page.getByText('That did not match. Check it and try again.')).toBeVisible();

	await page.getByLabel('Password', { exact: true }).fill(OWNER_PASSWORD);
	await page.getByRole('button', { name: 'Sign in with password' }).click();
	await expect(page.getByRole('button', { name: 'Security settings' })).toBeVisible();
	await expect(page.getByText('Upload files or text to get a shareable code')).toBeVisible();
});
