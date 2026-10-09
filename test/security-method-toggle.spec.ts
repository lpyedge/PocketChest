import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { ownerSignIn, resetStorage, setupTestEnvironment, testFetch, TEST_ORIGIN, TEST_OWNER_PASSWORD } from './utils/test-setup';
import { configureTotp, reauthPassword, call, adoptRotated, setEnabled, SignedIn } from './utils/security-helpers';
import { ownerRecord } from './utils/test-setup';

const SEED = new Uint8Array(20).map((_, index) => 90 + index);

async function signIn(): Promise<SignedIn> {
	return ownerSignIn();
}

async function toggle(session: SignedIn, method: string, enabled: boolean): Promise<Response> {
	return call(session, 'PATCH', '/api/admin/security/methods', { method, enabled });
}

describe('security status', () => {
	beforeAll(async () => {
		await resetStorage();
	});

	beforeEach(async () => {
		await setupTestEnvironment();
	});

	it('reports each method without its hash, seed or public key', async () => {
		const owner = await signIn();
		await configureTotp(SEED, true);
		const response = await call(owner, 'GET', '/api/admin/security');
		expect(response.status).toBe(200);
		const text = await response.text();
		const data = JSON.parse(text) as any;

		expect(data.methods.password).toEqual({ configured: true, enabled: true });
		expect(data.methods.totp).toEqual({ configured: true, enabled: true });
		expect(data.methods.passkey).toMatchObject({ configured: false, enabled: false, credentials: [] });
		const stored = await ownerRecord();
		expect(text).not.toContain(stored.methods.password.hash!.hash);
		expect(text).not.toContain(stored.methods.password.hash!.salt);
		expect(text).not.toContain(stored.methods.totp.encryptedSecret!.ct);
	});

	it('requires a signed-in session', async () => {
		await signIn();
		const response = await testFetch(`${TEST_ORIGIN}/api/admin/security`);
		expect(response.status).toBe(401);
		await response.text();
	});
});

describe('switching methods on and off', () => {
	beforeAll(async () => {
		await resetStorage();
	});

	beforeEach(async () => {
		await setupTestEnvironment();
	});

	it('refuses to switch on a method that has not been set up', async () => {
		const owner = await signIn();
		await reauthPassword(owner);
		const response = await toggle(owner, 'totp', true);
		expect(response.status).toBe(409);
		expect(((await response.json()) as any).code).toBe('AUTH_METHOD_NOT_CONFIGURED');
	});

	it('refuses to switch on a configured method without a re-entry with that same method', async () => {
		const owner = await signIn();
		await configureTotp(SEED, false);
		await reauthPassword(owner);
		const response = await toggle(owner, 'totp', true);
		expect(response.status).toBe(403);
		expect(((await response.json()) as any).code).toBe('REAUTH_METHOD_REQUIRED');
	});

	it('refuses to change anything without a recent re-entry', async () => {
		const owner = await signIn();
		const response = await toggle(owner, 'password', false);
		expect(response.status).toBe(403);
		expect(((await response.json()) as any).code).toBe('REAUTH_REQUIRED');
	});

	it('refuses to switch off the last usable method', async () => {
		const owner = await signIn();
		await reauthPassword(owner);
		const response = await toggle(owner, 'password', false);
		expect(response.status).toBe(409);
		expect(((await response.json()) as any).code).toBe('LAST_AUTH_METHOD');
	});

	it('switches a method off, ends every other session, and keeps the caller signed in', async () => {
		const first = await signIn();
		const second = await signIn();
		await configureTotp(SEED, true);
		await reauthPassword(first);

		const response = await toggle(first, 'password', false);
		expect(response.status).toBe(200);
		const { session: replaced, data } = await adoptRotated(first, response);
		expect(data.security.methods.password.enabled).toBe(false);

		const status = await call(replaced, 'GET', '/api/admin/security');
		expect(status.status).toBe(200);
		await status.text();
		const other = await call(second, 'GET', '/api/admin/security');
		expect(other.status).toBe(401);
		await other.text();
		const old = await call(first, 'GET', '/api/admin/security');
		expect(old.status).toBe(401);
		await old.text();
	});

	it('switching a method back on uses the same stored setup, after a re-entry with it', async () => {
		const owner = await signIn();
		await configureTotp(SEED, true);
		await reauthPassword(owner);
		const off = await toggle(owner, 'password', false);
		const { session } = await adoptRotated(owner, off);

		// Still configured, so re-entry with the password is possible while it is off
		await reauthPassword(session);
		const on = await toggle(session, 'password', true);
		expect(on.status).toBe(200);
		await on.text();

		const login = await testFetch(`${TEST_ORIGIN}/api/auth/login/password`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Origin: TEST_ORIGIN },
			body: JSON.stringify({ password: TEST_OWNER_PASSWORD }),
		});
		expect(login.status).toBe(200);
		await login.text();
	});

	it('lets exactly one of two concurrent switch-offs succeed when only two methods are on', async () => {
		const first = await signIn();
		const second = await signIn();
		await configureTotp(SEED, true);
		await reauthPassword(first);
		await reauthPassword(second);

		const [a, b] = await Promise.all([toggle(first, 'password', false), toggle(second, 'totp', false)]);
		const statuses = [a.status, b.status].sort();
		await a.text();
		await b.text();
		expect(statuses).toEqual([200, 409]);

		const stored = await ownerRecord();
		const usable = [stored.methods.password.enabled, stored.methods.totp.enabled].filter(Boolean).length;
		expect(usable).toBe(1);
	});
});

describe('passkey removal', () => {
	beforeAll(async () => {
		await resetStorage();
	});

	beforeEach(async () => {
		await setupTestEnvironment();
	});

	it('answers 404 for a passkey the owner does not have', async () => {
		const owner = await signIn();
		await reauthPassword(owner);
		const response = await call(owner, 'DELETE', '/api/admin/passkeys/unknown-id');
		expect(response.status).toBe(404);
		await response.text();
	});

	it('removing the last passkey switches the passkey method off, never leaving it on with no key', async () => {
		const owner = await signIn();
		// Give the owner one passkey directly, then turn the passkey method on as the only other method is off
		await env.R2_STORAGE.put(
			'auth/owner.json',
			JSON.stringify({
				...(await ownerRecord()),
				methods: {
					...(await ownerRecord()).methods,
					password: { ...(await ownerRecord()).methods.password, enabled: true },
					passkey: {
						enabled: true,
						credentials: [{ id: 'cred-one', publicKey: 'AAAA', counter: 0, label: 'Key', createdAt: 1, lastUsedAt: null, transports: [] }],
					},
				},
			}),
		);
		await reauthPassword(owner);
		const response = await call(owner, 'DELETE', '/api/admin/passkeys/cred-one');
		expect(response.status).toBe(200);
		const { data } = await adoptRotated(owner, response);
		expect(data.security.methods.passkey).toMatchObject({ enabled: false, credentials: [] });
	});

	it('refuses to remove a passkey when it is the only usable method', async () => {
		const owner = await signIn();
		const record = await ownerRecord();
		await env.R2_STORAGE.put(
			'auth/owner.json',
			JSON.stringify({
				...record,
				methods: {
					...record.methods,
					password: { ...record.methods.password, enabled: false },
					passkey: {
						enabled: true,
						credentials: [{ id: 'only-key', publicKey: 'AAAA', counter: 0, label: 'Key', createdAt: 1, lastUsedAt: null, transports: [] }],
					},
				},
			}),
		);
		await reauthPassword(owner);
		const response = await call(owner, 'DELETE', '/api/admin/passkeys/only-key');
		expect(response.status).toBe(409);
		expect(((await response.json()) as any).code).toBe('LAST_AUTH_METHOD');
	});
});
