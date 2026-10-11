import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import {
	ownerSignIn,
	resetStorage,
	setupTestEnvironment,
	testFetch,
	TEST_ORIGIN,
	TEST_OWNER_PASSWORD,
	ownerRecord,
	objectText,
	TEST_JWT_SECRET,
} from './utils/test-setup';
import { loadOwner, mutateOwner, OWNER_KEY } from '../src/worker/auth/owner';
import { loginWithTotp, reauthWithTotp } from '../src/worker/auth/login';
import { sealSeed, totpCodeAt } from '../src/worker/auth/totp';
import { sessionKey, sha256Hex } from '../src/worker/auth/sessions';
import { toBase64Url } from '../src/worker/auth/encoding';
import { ApiError } from '../src/worker/errors';

const bucket = () => env.R2_STORAGE;
// A step boundary (30 * 60,000,000), so step arithmetic in the direct tests is exact
const NOW = 1_800_000_000;
const SEED = new Uint8Array(20).map((_, index) => index + 1);
const OTHER_SEED = new Uint8Array(20).fill(0x5a);

// Gives the owner an authenticator with this seed. The password is switched off unless asked to stay on.
async function enableTotp(seed: Uint8Array, options: { passwordEnabled: boolean; totpEnabled?: boolean }) {
	const sealed = await sealSeed(seed, TEST_JWT_SECRET);
	await mutateOwner(bucket(), (owner) => ({
		...owner,
		methods: {
			password: { ...owner.methods.password, enabled: options.passwordEnabled },
			totp: { enabled: options.totpEnabled ?? true, encryptedSecret: sealed, lastAcceptedStep: null },
			passkey: owner.methods.passkey,
		},
	}));
}

async function loginHttp(code: string) {
	return testFetch(`${TEST_ORIGIN}/api/auth/login/totp`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Origin: TEST_ORIGIN },
		body: JSON.stringify({ code }),
	});
}

async function rejectsWith(promise: Promise<unknown>, status: number): Promise<void> {
	const error = await promise.then(
		() => null,
		(caught: unknown) => caught,
	);
	expect(error).toBeInstanceOf(ApiError);
	expect((error as ApiError).status).toBe(status);
}

describe('POST /api/auth/login/totp', () => {
	beforeAll(async () => {
		await resetStorage();
	});

	beforeEach(async () => {
		await setupTestEnvironment();
		await ownerSignIn();
		await enableTotp(SEED, { passwordEnabled: false });
	});

	it('signs the owner in with an authenticator code alone when the password is switched off', async () => {
		const code = await totpCodeAt(SEED, Math.floor(Date.now() / 1000));
		const response = await loginHttp(code);

		expect(response.status).toBe(200);
		const cookie = (response.headers.get('Set-Cookie') ?? '').split(';')[0];
		expect(cookie).toMatch(/^__Host-pc_owner=/);
		const data = (await response.json()) as any;
		expect(typeof data.csrfToken).toBe('string');

		const status = await testFetch(`${TEST_ORIGIN}/api/auth/session`, { headers: { Cookie: cookie } });
		expect(await status.json()).toMatchObject({ authenticated: true });

		// The password is not needed, and is refused here because it is switched off
		const password = await testFetch(`${TEST_ORIGIN}/api/auth/login/password`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Origin: TEST_ORIGIN },
			body: JSON.stringify({ password: TEST_OWNER_PASSWORD }),
		});
		expect(password.status).toBe(403);
		await password.text();
	});

	it('accepts a code only once within the same step, including when sent in parallel', async () => {
		const code = await totpCodeAt(SEED, Math.floor(Date.now() / 1000));
		const responses = await Promise.all(Array.from({ length: 20 }, () => loginHttp(code)));
		const statuses = responses.map((response) => response.status);
		await Promise.all(responses.map((response) => response.text()));

		expect(statuses.filter((status) => status === 200)).toHaveLength(1);
		for (const status of statuses.filter((value) => value !== 200)) {
			// 429: refused before checking, because the owner's guess budget (see reserveAttempt) was already taken by the parallel requests
			expect([401, 409, 429]).toContain(status);
		}
	});

	it('does not accept a step again, even when it is still inside the window later', async () => {
		const stepOne = await totpCodeAt(SEED, NOW);
		const stepTwo = await totpCodeAt(SEED, NOW + 30);

		await loginWithTotp(env, stepOne, NOW);
		await loginWithTotp(env, stepTwo, NOW + 30);
		// Step one is still within the window at NOW + 30, but it is earlier than the last accepted step
		await rejectsWith(loginWithTotp(env, stepOne, NOW + 30), 401);
	});

	it('accepts a neighbouring step for clock drift, but not one that is already used', async () => {
		const previous = await totpCodeAt(SEED, NOW - 30);
		await loginWithTotp(env, previous, NOW);
		await rejectsWith(loginWithTotp(env, previous, NOW), 401);
	});

	it('rejects a step that is outside the window', async () => {
		const tooOld = await totpCodeAt(SEED, NOW - 120);
		await rejectsWith(loginWithTotp(env, tooOld, NOW), 401);
	});

	it.each([
		['a wrong code', '000000x'],
		['a short code', '12345'],
		['a non-numeric code', 'abcdef'],
		['an empty code', ''],
	])('answers %s with 401', async (_label, code) => {
		const response = await loginHttp(code);
		expect(response.status).toBe(401);
		expect(((await response.json()) as any).code).toBe('AUTH_INVALID_CREDENTIALS');
	});

	it('answers a missing code with 401, the same as a wrong one', async () => {
		const response = await testFetch(`${TEST_ORIGIN}/api/auth/login/totp`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Origin: TEST_ORIGIN },
			body: '{}',
		});
		expect(response.status).toBe(401);
		await response.text();
	});

	it('refuses a code generated from a different seed', async () => {
		await rejectsWith(loginWithTotp(env, await totpCodeAt(OTHER_SEED, NOW), NOW), 401);
	});

	it('is refused when the authenticator method is switched off', async () => {
		await enableTotp(SEED, { passwordEnabled: true, totpEnabled: false });
		await rejectsWith(loginWithTotp(env, await totpCodeAt(SEED, NOW), NOW), 403);
	});

	it('refuses a cross-origin request before checking the code', async () => {
		const response = await testFetch(`${TEST_ORIGIN}/api/auth/login/totp`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
			body: JSON.stringify({ code: await totpCodeAt(SEED, Math.floor(Date.now() / 1000)) }),
		});
		expect(response.status).toBe(403);
		await response.text();
	});

	it('fails closed when the root secret is missing, too short or different from the one that sealed the seed', async () => {
		const code = await totpCodeAt(SEED, NOW);
		await rejectsWith(loginWithTotp({ ...env, JWT_SECRET: undefined as unknown as string }, code, NOW), 500);
		await rejectsWith(loginWithTotp({ ...env, JWT_SECRET: 'short' }, code, NOW), 500);
		await rejectsWith(loginWithTotp({ ...env, JWT_SECRET: 'a-different-root-secret-of-good-length' }, code, NOW), 500);
	});

	it('never stores the seed in plain form', async () => {
		const stored = await await objectText(OWNER_KEY);
		expect(stored).not.toContain(toBase64Url(SEED));
		expect(stored).not.toContain(toBase64Url(OTHER_SEED));
		const sealedA = await sealSeed(SEED, TEST_JWT_SECRET);
		const sealedB = await sealSeed(SEED, TEST_JWT_SECRET);
		expect(sealedA.ct).not.toBe(sealedB.ct);
	});

	it('leaves the owner record and its authVersion usable after a sign-in', async () => {
		const before = await ownerRecord();
		await loginWithTotp(env, await totpCodeAt(SEED, NOW), NOW);
		const after = await ownerRecord();

		expect(after.authVersion).toBe(before.authVersion);
		expect(after.methods.totp.lastAcceptedStep).not.toBeNull();
	});
});

describe('POST /api/auth/reauth/totp', () => {
	beforeAll(async () => {
		await resetStorage();
	});

	beforeEach(async () => {
		await setupTestEnvironment();
	});

	it('opens the reauth window once for the signed-in session, and a code cannot be replayed', async () => {
		const owner = await ownerSignIn();
		await enableTotp(SEED, { passwordEnabled: true });
		// The HTTP endpoint reads the real clock, so this test uses the current time
		const now = Math.floor(Date.now() / 1000);
		const code = await totpCodeAt(SEED, now);
		const headers = {
			Origin: TEST_ORIGIN,
			Cookie: owner.cookie,
			'X-PocketChest-CSRF': owner.csrfToken,
			'Content-Type': 'application/json',
		};

		const first = await testFetch(`${TEST_ORIGIN}/api/auth/reauth/totp`, { method: 'POST', headers, body: JSON.stringify({ code }) });
		expect(first.status).toBe(200);
		await first.text();

		const sid = owner.cookie.split('=')[1];
		const record = JSON.parse((await (await bucket().get(sessionKey(await sha256Hex(sid))))!.text()) as string);
		expect(typeof record.reauthenticatedAt).toBe('number');

		await rejectsWith(reauthWithTotp(env, { key: '', sid, record }, code, now), 401);
	});

	it('requires the signed-in session and the CSRF token', async () => {
		const owner = await ownerSignIn();
		await enableTotp(SEED, { passwordEnabled: true });
		const response = await testFetch(`${TEST_ORIGIN}/api/auth/reauth/totp`, {
			method: 'POST',
			headers: { Origin: TEST_ORIGIN, Cookie: owner.cookie, 'Content-Type': 'application/json' },
			body: JSON.stringify({ code: await totpCodeAt(SEED, Math.floor(Date.now() / 1000)) }),
		});
		expect(response.status).toBe(403);
		await response.text();
	});
});
