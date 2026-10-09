import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
	ownerSignIn,
	ownerRecord,
	resetStorage,
	setupTestEnvironment,
	testFetch,
	TEST_ORIGIN,
	TEST_OWNER_PASSWORD,
} from './utils/test-setup';
import { adoptRotated, call, configureTotp, reauthPassword, setEnabled, SignedIn } from './utils/security-helpers';

const NEW_PASSWORD = 'a-new-passphrase-that-is-long-enough';

function login(password: string) {
	return testFetch(`${TEST_ORIGIN}/api/auth/login/password`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Origin: TEST_ORIGIN },
		body: JSON.stringify({ password }),
	});
}

function changeTo(session: SignedIn, newPassword: unknown, confirmPassword: unknown) {
	return call(session, 'POST', '/api/admin/security/password', { newPassword, confirmPassword });
}

describe('POST /api/admin/security/password', () => {
	beforeAll(async () => {
		await resetStorage();
	});

	beforeEach(async () => {
		await setupTestEnvironment();
	});

	it('needs a recent re-entry', async () => {
		const owner = await ownerSignIn();
		const response = await changeTo(owner, NEW_PASSWORD, NEW_PASSWORD);
		expect(response.status).toBe(403);
		expect(((await response.json()) as any).code).toBe('REAUTH_REQUIRED');
	});

	it.each([
		['too short', 'short-one', 'short-one', 'PASSWORD_TOO_SHORT'],
		['not confirmed', NEW_PASSWORD, `${NEW_PASSWORD}-x`, 'PASSWORD_MISMATCH'],
		['a repeated character', 'a'.repeat(20), 'a'.repeat(20), 'PASSWORD_TOO_WEAK'],
		['the same as now', TEST_OWNER_PASSWORD, TEST_OWNER_PASSWORD, 'PASSWORD_UNCHANGED'],
	])('refuses a password that is %s', async (_label, newPassword, confirm, code) => {
		const owner = await ownerSignIn();
		await reauthPassword(owner);
		const response = await changeTo(owner, newPassword, confirm);
		expect(response.status).toBe(400);
		expect(((await response.json()) as any).code).toBe(code);
	});

	it('makes the new password work, the old one stop working, and ends every other session', async () => {
		const current = await ownerSignIn();
		const other = await ownerSignIn();
		await reauthPassword(current);

		const response = await changeTo(current, NEW_PASSWORD, NEW_PASSWORD);
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(text).not.toContain(NEW_PASSWORD);
		const { session: replaced, data } = await adoptRotated(current, new Response(text, { headers: response.headers }));
		expect(data.csrfToken).toEqual(expect.any(String));

		// The current browser stays signed in with a fresh cookie; the old cookie and the other session are gone
		const stillIn = await call(replaced, 'GET', '/api/admin/security');
		expect(stillIn.status).toBe(200);
		await stillIn.text();
		for (const stale of [current, other]) {
			const refused = await call(stale, 'GET', '/api/admin/security');
			expect(refused.status).toBe(401);
			await refused.text();
		}

		const oldLogin = await login(TEST_OWNER_PASSWORD);
		expect(oldLogin.status).toBe(401);
		await oldLogin.text();
		const newLogin = await login(NEW_PASSWORD);
		expect(newLogin.status).toBe(200);
		await newLogin.text();
	});

	it('stores the new hash with a new salt', async () => {
		const owner = await ownerSignIn();
		const before = (await ownerRecord()).methods.password.hash!;
		await reauthPassword(owner);
		await (await changeTo(owner, NEW_PASSWORD, NEW_PASSWORD)).text();

		const after = (await ownerRecord()).methods.password.hash!;
		expect(after.salt).not.toBe(before.salt);
		expect(after.hash).not.toBe(before.hash);
		expect(JSON.stringify(await env.R2_STORAGE.list())).not.toContain(NEW_PASSWORD);
	});

	it('changes the stored password while it is switched off, without switching it back on', async () => {
		const owner = await ownerSignIn();
		await configureTotp(new Uint8Array(20).fill(7), true);
		await reauthPassword(owner);
		await setEnabled('password', false);

		const changed = await changeTo(owner, NEW_PASSWORD, NEW_PASSWORD);
		expect(changed.status).toBe(200);
		await changed.text();
		expect((await ownerRecord()).methods.password.enabled).toBe(false);
	});
});
