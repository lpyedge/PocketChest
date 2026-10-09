import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { ownerSignIn, resetStorage, setupTestEnvironment, testFetch, TEST_ORIGIN, TEST_OWNER_PASSWORD } from './utils/test-setup';
import { BOOTSTRAP_MARKER_KEY } from '../src/worker/auth/bootstrap';
import { OWNER_KEY, loadOwner } from '../src/worker/auth/owner';
import { assertRecentReauth, REAUTH_SECONDS, sessionKey, sha256Hex } from '../src/worker/auth/sessions';
import { ApiError } from '../src/worker/errors';

const bucket = () => env.R2_STORAGE;
const WRONG_PASSWORD = 'definitely-not-the-owner-password';

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
	return testFetch(`${TEST_ORIGIN}${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Origin: TEST_ORIGIN, ...headers },
		body: typeof body === 'string' ? body : JSON.stringify(body),
	});
}

function cookieOf(response: Response): string {
	return (response.headers.get('Set-Cookie') ?? '').split(';')[0];
}

// Writes the owner record directly, bypassing the invariant, to model a record that disables password
async function setPasswordEnabled(enabled: boolean) {
	const loaded = await loadOwner(bucket());
	if (!loaded) {
		throw new Error('Owner must exist before switching a method');
	}
	const { owner } = loaded;
	const raw = { ...owner, methods: { ...owner.methods, password: { ...owner.methods.password, enabled } } };
	await bucket().put(OWNER_KEY, JSON.stringify(raw));
}

async function sessionRecord(cookie: string): Promise<any> {
	const sid = cookie.split('=')[1];
	const object = await bucket().get(sessionKey(await sha256Hex(sid)));
	return object ? JSON.parse(await object.text()) : null;
}

describe('GET /api/auth/methods', () => {
	beforeAll(async () => {
		await resetStorage();
	});

	beforeEach(async () => {
		await setupTestEnvironment();
	});

	it('offers setup only on an empty bucket with bootstrap enabled', async () => {
		const response = await testFetch(`${TEST_ORIGIN}/api/auth/methods`);
		expect(response.status).toBe(200);
		const data = (await response.json()) as any;
		expect(data.setupRequired).toBe(true);
		expect(data.methods.password.enabled).toBe(false);
	});

	it('reports each method on its own once the owner exists', async () => {
		await ownerSignIn();
		const data = (await (await testFetch(`${TEST_ORIGIN}/api/auth/methods`)).json()) as any;

		expect(data.setupRequired).toBe(false);
		expect(data.methods).toEqual({ password: { enabled: true }, totp: { enabled: false }, passkey: { enabled: false } });
	});

	it('does not offer setup again after the bootstrap marker was claimed', async () => {
		await bucket().put(BOOTSTRAP_MARKER_KEY, 'claimed');
		const data = (await (await testFetch(`${TEST_ORIGIN}/api/auth/methods`)).json()) as any;

		expect(data.setupRequired).toBe(false);
	});

	it('never returns the password hash or any other secret material', async () => {
		await ownerSignIn();
		const text = await (await testFetch(`${TEST_ORIGIN}/api/auth/methods`)).text();
		const stored = (await loadOwner(bucket()))?.owner.methods.password.hash;
		if (!stored) {
			throw new Error('Owner password hash missing');
		}

		expect(text).not.toContain(stored.hash);
		expect(text).not.toContain(stored.salt);
		expect(text).not.toContain(TEST_OWNER_PASSWORD);
	});
});

describe('POST /api/auth/login/password', () => {
	beforeAll(async () => {
		await resetStorage();
	});

	beforeEach(async () => {
		await setupTestEnvironment();
		await ownerSignIn();
	});

	it('answers a body that is not JSON with 400, which reveals nothing about credentials', async () => {
		const response = await post('/api/auth/login/password', '{not json');
		expect(response.status).toBe(400);
		await response.text();
	});

	it('starts a session with an HttpOnly, Secure, SameSite=Strict cookie and returns the CSRF token', async () => {
		const response = await post('/api/auth/login/password', { password: TEST_OWNER_PASSWORD });
		expect(response.status).toBe(200);

		const setCookie = response.headers.get('Set-Cookie') ?? '';
		expect(setCookie).toMatch(/^__Host-pc_owner=[A-Za-z0-9_-]+; Path=\/; HttpOnly; Secure; SameSite=Strict$/);
		expect(setCookie).not.toMatch(/Domain=/i);

		const data = (await response.json()) as any;
		expect(data).toMatchObject({ authenticated: true });
		expect(typeof data.csrfToken).toBe('string');
		expect(JSON.stringify(data) + setCookie).not.toContain(TEST_OWNER_PASSWORD);
	});

	it('issues a session that the owner status endpoint accepts', async () => {
		const login = await post('/api/auth/login/password', { password: TEST_OWNER_PASSWORD });
		const cookie = cookieOf(login);
		await login.text();

		const status = await testFetch(`${TEST_ORIGIN}/api/auth/session`, { headers: { Cookie: cookie } });
		expect(await status.json()).toMatchObject({ authenticated: true });
	});

	it('gives every login a new session id', async () => {
		const first = cookieOf(await post('/api/auth/login/password', { password: TEST_OWNER_PASSWORD }));
		const second = cookieOf(await post('/api/auth/login/password', { password: TEST_OWNER_PASSWORD }));
		expect(first).not.toBe(second);
	});

	it('answers a wrong password with 401 and starts no session', async () => {
		const before = (await bucket().list({ prefix: 'auth/sessions/' })).objects.length;
		const response = await post('/api/auth/login/password', { password: WRONG_PASSWORD });
		expect(response.status).toBe(401);
		expect(((await response.json()) as any).code).toBe('AUTH_INVALID_CREDENTIALS');
		expect(response.headers.get('Set-Cookie')).toBeNull();
		expect((await bucket().list({ prefix: 'auth/sessions/' })).objects).toHaveLength(before);
	});

	it.each([
		['missing', {}],
		['empty', { password: '' }],
		['not a string', { password: 12345 }],
	])('answers a %s password with the same 401 as a wrong one', async (_label, body) => {
		const response = await post('/api/auth/login/password', body);
		expect(response.status).toBe(401);
		expect(((await response.json()) as any).code).toBe('AUTH_INVALID_CREDENTIALS');
	});

	it('refuses a cross-origin request before checking the password', async () => {
		const response = await post('/api/auth/login/password', { password: TEST_OWNER_PASSWORD }, { Origin: 'https://evil.example' });
		expect(response.status).toBe(403);
		expect(response.headers.get('Set-Cookie')).toBeNull();
		await response.text();
	});

	it('is refused when the password method is switched off', async () => {
		await setPasswordEnabled(false);
		const response = await post('/api/auth/login/password', { password: TEST_OWNER_PASSWORD });

		expect(response.status).toBe(403);
		expect(((await response.json()) as any).code).toBe('AUTH_METHOD_DISABLED');
		expect(response.headers.get('Set-Cookie')).toBeNull();
	});

	it('is refused when there is no owner', async () => {
		await resetStorage();
		const response = await post('/api/auth/login/password', { password: TEST_OWNER_PASSWORD });
		expect(response.status).toBe(401);
		await response.text();
	});
});

describe('POST /api/auth/reauth/password', () => {
	beforeAll(async () => {
		await resetStorage();
	});

	beforeEach(async () => {
		await setupTestEnvironment();
	});

	it('requires a signed-in session and the CSRF token', async () => {
		const owner = await ownerSignIn();

		const anonymous = await post('/api/auth/reauth/password', { password: TEST_OWNER_PASSWORD }, { Origin: TEST_ORIGIN });
		expect(anonymous.status).toBe(401);
		await anonymous.text();

		const noCsrf = await post('/api/auth/reauth/password', { password: TEST_OWNER_PASSWORD }, { Cookie: owner.cookie });
		expect(noCsrf.status).toBe(403);
		await noCsrf.text();
	});

	it('does not open the reauth window for a wrong password', async () => {
		const owner = await ownerSignIn();
		const response = await post(
			'/api/auth/reauth/password',
			{ password: WRONG_PASSWORD },
			{ Cookie: owner.cookie, 'X-PocketChest-CSRF': owner.csrfToken },
		);

		expect(response.status).toBe(401);
		await response.text();
		expect((await sessionRecord(owner.cookie)).reauthenticatedAt).toBeNull();
	});

	it('opens the reauth window for the current session with the right password', async () => {
		const owner = await ownerSignIn();
		const response = await post(
			'/api/auth/reauth/password',
			{ password: TEST_OWNER_PASSWORD },
			{ Cookie: owner.cookie, 'X-PocketChest-CSRF': owner.csrfToken },
		);

		expect(response.status).toBe(200);
		await response.text();
		expect(typeof (await sessionRecord(owner.cookie)).reauthenticatedAt).toBe('number');
	});

	it('refuses re-entry with a switched-off password, as it refuses sign-in', async () => {
		const owner = await ownerSignIn();
		await setPasswordEnabled(false);
		const response = await post(
			'/api/auth/reauth/password',
			{ password: TEST_OWNER_PASSWORD },
			{ Cookie: owner.cookie, 'X-PocketChest-CSRF': owner.csrfToken },
		);
		expect(response.status).toBe(403);
		expect(((await response.json()) as any).code).toBe('AUTH_METHOD_DISABLED');
		expect((await sessionRecord(owner.cookie)).reauthMethod).toBeNull();

		const login = await post('/api/auth/login/password', { password: TEST_OWNER_PASSWORD });
		expect(login.status).toBe(403);
		await login.text();
	});
});

describe('recent reauth window', () => {
	const NOW = 1_800_000_000;
	const session = (reauthenticatedAt: number | null) => ({
		key: 'auth/sessions/x',
		sid: 'x',
		record: {
			version: 1 as const,
			createdAt: NOW - 1000,
			lastSeenAt: NOW,
			absoluteExpiresAt: NOW + 100_000,
			ownerAuthVersion: 1,
			reauthenticatedAt,
			reauthMethod: reauthenticatedAt === null ? null : ('password' as const),
		},
	});

	it('accepts a re-entry made within the window', () => {
		expect(() => assertRecentReauth(session(NOW - 10), NOW)).not.toThrow();
	});

	it('refuses once the window has passed', () => {
		expect(() => assertRecentReauth(session(NOW - REAUTH_SECONDS), NOW)).toThrow(ApiError);
	});

	it('refuses a session that never re-entered the password', () => {
		expect(() => assertRecentReauth(session(null), NOW)).toThrow(ApiError);
	});

	it('refuses a timestamp in the future', () => {
		expect(() => assertRecentReauth(session(NOW + 60), NOW)).toThrow(ApiError);
	});
});
