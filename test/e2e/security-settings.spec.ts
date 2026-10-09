import { createHmac } from 'node:crypto';
import { test, expect, Page } from '@playwright/test';
import { ORIGIN, OWNER_PASSWORD, randomClientIp, useClientAddress } from './owner';

test.beforeEach(async ({ page }) => {
	await useClientAddress(page, randomClientIp());
});

// Chromium's virtual authenticator answers WebAuthn prompts without a person, as a real key would
async function addVirtualAuthenticator(page: Page) {
	const session = await page.context().newCDPSession(page);
	await session.send('WebAuthn.enable');
	await session.send('WebAuthn.addVirtualAuthenticator', {
		options: {
			protocol: 'ctap2',
			transport: 'internal',
			hasResidentKey: true,
			hasUserVerification: true,
			isUserVerified: true,
			automaticPresenceSimulation: true,
		},
	});
}

test('adds a passkey, switches it on, signs in with it, and removes it again', async ({ page, request }) => {
	await request.post('/api/auth/bootstrap', { headers: { Origin: ORIGIN }, data: { password: OWNER_PASSWORD } });
	await addVirtualAuthenticator(page);
	// Accepts the confirmation prompt before removing a passkey
	page.on('dialog', (dialog) => dialog.accept());

	await page.goto('/upload/');
	await page.getByLabel('Password', { exact: true }).fill(OWNER_PASSWORD);
	await page.getByRole('button', { name: 'Sign in with password' }).click();
	await page.getByRole('button', { name: 'Security settings' }).click();

	const dialog = page.getByRole('dialog', { name: 'Security settings' });
	const passkeys = dialog.locator('section', { hasText: 'Passkeys' });

	// Adding a passkey needs a re-entry first; the password is offered and the registration then continues
	await passkeys.getByRole('button', { name: 'Add passkey' }).click();
	await dialog.getByLabel('Password', { exact: true }).fill(OWNER_PASSWORD);
	await dialog.getByRole('button', { name: 'Confirm with password' }).click();
	await expect(passkeys.getByText('This device')).toBeVisible();
	// A new passkey is not used for sign-in until the method is switched on
	await expect(passkeys.getByText('Off (set up)')).toBeVisible();

	// Switching it on needs a re-entry with the passkey itself
	await passkeys.getByRole('button', { name: 'Turn on' }).click();
	await dialog.getByRole('button', { name: 'Confirm with passkey' }).click();
	await expect(passkeys.getByText('On', { exact: true })).toBeVisible();

	// Sign out, then sign in again with the passkey alone
	await dialog.getByRole('button', { name: 'Sign out' }).click();
	await page.getByRole('button', { name: 'Sign in with passkey' }).click();
	await expect(page.getByRole('button', { name: 'Security settings' })).toBeVisible();

	// Remove the test passkey, so the shared development state is left as it was
	await page.getByRole('button', { name: 'Security settings' }).click();
	await passkeys.getByRole('button', { name: 'Remove' }).click();
	await dialog.getByRole('button', { name: 'Confirm with passkey' }).click();
	await expect(passkeys.getByText('Not set up')).toBeVisible();
});

test('shows a scannable QR code and the manual key for the authenticator, and cancelling changes nothing', async ({ page, request }) => {
	await request.post('/api/auth/bootstrap', { headers: { Origin: ORIGIN }, data: { password: OWNER_PASSWORD } });

	let secret = '';
	page.on('response', async (response) => {
		if (response.url().endsWith('/api/admin/security/totp/prepare') && response.ok()) {
			const uri = ((await response.json()) as { otpauthUri: string }).otpauthUri;
			secret = new URL(uri).searchParams.get('secret') ?? '';
		}
	});

	await page.goto('/upload/');
	await page.getByLabel('Password', { exact: true }).fill(OWNER_PASSWORD);
	await page.getByRole('button', { name: 'Sign in with password' }).click();
	await page.getByRole('button', { name: 'Security settings' }).click();

	const dialog = page.getByRole('dialog', { name: 'Security settings' });
	const authenticator = dialog.locator('section', { hasText: 'Authenticator app' });
	const before = await authenticator.innerText();

	await authenticator.getByRole('button', { name: /Set up authenticator|Replace authenticator/ }).click();
	await dialog.getByLabel('Password', { exact: true }).fill(OWNER_PASSWORD);
	await dialog.getByRole('button', { name: 'Confirm with password' }).click();

	const qr = authenticator.getByRole('img', { name: 'QR code for your authenticator app' });
	await expect(qr).toBeVisible();
	const box = await qr.boundingBox();
	expect(box!.width).toBeGreaterThan(150);
	await expect(authenticator.getByTestId('totp-secret')).toHaveText(/^([A-Z2-7]{4} ?)+$/);
	expect(secret).toMatch(/^[A-Z2-7]{32}$/);
	expect((await authenticator.getByTestId('totp-secret').innerText()).replace(/\s/g, '')).toBe(secret);

	// The seed is not kept anywhere in the browser
	const stored = (await page.evaluate(`JSON.stringify([window.localStorage, window.sessionStorage])`)) as string;
	expect(stored).not.toContain(secret);

	// Cancelling leaves the authenticator exactly as it was
	await authenticator.getByRole('button', { name: /^Cancel/ }).click();
	await expect(qr).toBeHidden();
	expect(await authenticator.innerText()).toBe(before);
});

// RFC 6238, SHA-1, 6 digits, 30 seconds: what an authenticator app computes from the Base32 key
function totpFor(base32: string, atSeconds: number): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
	let bits = '';
	for (const char of base32) bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
	const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(Math.floor(atSeconds / 30)));
	const hmac = createHmac('sha1', key).update(counter).digest();
	const offset = hmac[hmac.length - 1] & 0x0f;
	const value = hmac.readUInt32BE(offset) & 0x7fffffff;
	return String(value % 1_000_000).padStart(6, '0');
}

test('a wrong authenticator code keeps the QR usable, and the right code then completes setup', async ({ page, request }) => {
	await request.post('/api/auth/bootstrap', { headers: { Origin: ORIGIN }, data: { password: OWNER_PASSWORD } });
	let secret = '';
	page.on('response', async (response) => {
		if (response.url().endsWith('/api/admin/security/totp/prepare') && response.ok()) {
			secret = new URL(((await response.json()) as { otpauthUri: string }).otpauthUri).searchParams.get('secret') ?? '';
		}
	});

	await page.goto('/upload/');
	await page.getByLabel('Password', { exact: true }).fill(OWNER_PASSWORD);
	await page.getByRole('button', { name: 'Sign in with password' }).click();
	await page.getByRole('button', { name: 'Security settings' }).click();
	const dialog = page.getByRole('dialog', { name: 'Security settings' });
	const authenticator = dialog.locator('section', { hasText: 'Authenticator app' });

	await authenticator.getByRole('button', { name: /Set up authenticator|Replace authenticator/ }).click();
	await dialog.getByLabel('Password', { exact: true }).fill(OWNER_PASSWORD);
	await dialog.getByRole('button', { name: 'Confirm with password' }).click();
	const qr = authenticator.getByRole('img', { name: 'QR code for your authenticator app' });
	await expect(qr).toBeVisible();
	const shownBefore = await authenticator.getByTestId('totp-secret').innerText();

	// One typo: the message says so, and the very same QR and key are still on screen
	const input = authenticator.getByLabel('New authenticator code');
	await input.fill('000000');
	await authenticator.getByRole('button', { name: 'Confirm code' }).click();
	await expect(dialog.getByText(/does not match/i)).toBeVisible();
	await expect(qr).toBeVisible();
	expect(await authenticator.getByTestId('totp-secret').innerText()).toBe(shownBefore);

	// The correct code from that same key completes the setup
	await input.fill(totpFor(secret, Date.now() / 1000));
	await authenticator.getByRole('button', { name: 'Confirm code' }).click();
	await expect(qr).toBeHidden();
	await expect(authenticator.getByText(/Off \(set up\)|On/).first()).toBeVisible();
});
