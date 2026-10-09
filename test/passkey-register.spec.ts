import { env, createExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import worker from '../src/worker/index';
import {
	ownerSignIn,
	resetStorage,
	setupTestEnvironment,
	testFetch,
	TEST_ORIGIN,
	TEST_OWNER_PASSWORD,
	ownerRecord,
} from './utils/test-setup';
import { VirtualAuthenticator } from './utils/virtual-authenticator';
import { CHALLENGE_PREFIX, cleanupChallenges, consumeChallenge, storeChallenge } from '../src/worker/auth/challenges';
import { sha256Hex } from '../src/worker/auth/sessions';
import { cleanupExpired } from '../src/worker/storage';
import { ApiError } from '../src/worker/errors';
import type { Env } from '../src/worker/types';

const bucket = () => env.R2_STORAGE;
const RP_ID = new URL(TEST_ORIGIN).hostname;
const NOW = 1_800_000_000;

type Owner = Awaited<ReturnType<typeof ownerSignIn>>;

function signedIn(owner: Owner, extra: Record<string, string> = {}) {
	return { Origin: TEST_ORIGIN, Cookie: owner.cookie, 'X-PocketChest-CSRF': owner.csrfToken, 'Content-Type': 'application/json', ...extra };
}

async function reauthenticate(owner: Owner): Promise<void> {
	const response = await testFetch(`${TEST_ORIGIN}/api/auth/reauth/password`, {
		method: 'POST',
		headers: signedIn(owner),
		body: JSON.stringify({ password: TEST_OWNER_PASSWORD }),
	});
	expect(response.status).toBe(200);
	await response.text();
}

async function registerOptions(owner: Owner, env2?: Env) {
	const request = new Request(`${TEST_ORIGIN}/api/admin/passkeys/register/options`, {
		method: 'POST',
		headers: signedIn(owner),
		body: '{}',
	});
	const response = await (env2
		? worker.fetch(request, env2, createExecutionContext())
		: testFetch(`${TEST_ORIGIN}/api/admin/passkeys/register/options`, { method: 'POST', headers: signedIn(owner), body: '{}' }));
	return response;
}

async function registerVerify(owner: Owner, body: unknown) {
	return testFetch(`${TEST_ORIGIN}/api/admin/passkeys/register/verify`, {
		method: 'POST',
		headers: signedIn(owner),
		body: JSON.stringify(body),
	});
}

// Full registration as a browser does it, with the authenticator passed in
async function registerPasskey(owner: Owner, authenticator: VirtualAuthenticator, overrides = {}, credentialId?: string) {
	const options = (await (await registerOptions(owner)).json()) as any;
	const response = await authenticator.register(options, { ...overrides, credentialId });
	return registerVerify(owner, { challenge: options.challenge, response, label: 'Test key' });
}

async function storedCredentials(): Promise<any[]> {
	return (await ownerRecord()).methods.passkey.credentials;
}

describe('passkey registration', () => {
	let authenticator: VirtualAuthenticator;

	beforeAll(async () => {
		await resetStorage();
	});

	beforeEach(async () => {
		await setupTestEnvironment();
		authenticator = new VirtualAuthenticator(RP_ID, TEST_ORIGIN);
	});

	it('lets a recently re-authenticated owner register a passkey, and keeps only its public key', async () => {
		const owner = await ownerSignIn();
		await reauthenticate(owner);
		const response = await registerPasskey(owner, authenticator);

		expect(response.status).toBe(200);
		const data = (await response.json()) as any;
		expect(data).toMatchObject({ registered: true });

		const [credential] = await storedCredentials();
		expect(credential).toMatchObject({ label: 'Test key', counter: 0, lastUsedAt: null, transports: ['internal'] });
		expect(credential.publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
		// Adding a passkey does not switch the method on
		expect((await ownerRecord()).methods.passkey.enabled).toBe(false);
	});

	it('allows at least two passkeys', async () => {
		const owner = await ownerSignIn();
		await reauthenticate(owner);
		expect((await registerPasskey(owner, authenticator)).status).toBe(200);
		await reauthenticate(owner);
		expect((await registerPasskey(owner, authenticator)).status).toBe(200);
		expect(await storedCredentials()).toHaveLength(2);
	});

	it('refuses to start registration without a signed-in session', async () => {
		await ownerSignIn();
		const response = await testFetch(`${TEST_ORIGIN}/api/admin/passkeys/register/options`, {
			method: 'POST',
			headers: { Origin: TEST_ORIGIN, 'Content-Type': 'application/json' },
			body: '{}',
		});
		expect(response.status).toBe(401);
		await response.text();
	});

	it('refuses to start registration without the CSRF token', async () => {
		const owner = await ownerSignIn();
		await reauthenticate(owner);
		const response = await testFetch(`${TEST_ORIGIN}/api/admin/passkeys/register/options`, {
			method: 'POST',
			headers: { Origin: TEST_ORIGIN, Cookie: owner.cookie, 'Content-Type': 'application/json' },
			body: '{}',
		});
		expect(response.status).toBe(403);
		await response.text();
	});

	it('refuses to start registration without a recent re-entry of the password', async () => {
		const owner = await ownerSignIn();
		const response = await registerOptions(owner);
		expect(response.status).toBe(403);
		expect(((await response.json()) as any).code).toBe('REAUTH_REQUIRED');
	});

	it('refuses a credential that is already registered', async () => {
		const owner = await ownerSignIn();
		await reauthenticate(owner);
		const first = await registerPasskey(owner, authenticator);
		expect(first.status).toBe(200);
		await first.text();

		await reauthenticate(owner);
		const same = await registerPasskey(owner, authenticator, {}, (await storedCredentials())[0].id);
		expect(same.status).toBe(409);
		expect(((await same.json()) as any).code).toBe('PASSKEY_ALREADY_REGISTERED');
		expect(await storedCredentials()).toHaveLength(1);
	});

	it('does not accept the same challenge twice', async () => {
		const owner = await ownerSignIn();
		await reauthenticate(owner);
		const options = (await (await registerOptions(owner)).json()) as any;
		const response = await authenticator.register(options);

		const first = await registerVerify(owner, { challenge: options.challenge, response });
		expect(first.status).toBe(200);
		await first.text();
		const replay = await registerVerify(owner, { challenge: options.challenge, response: await authenticator.register(options) });
		expect(replay.status).toBe(400);
		expect(((await replay.json()) as any).code).toBe('CHALLENGE_INVALID');
		expect(await storedCredentials()).toHaveLength(1);
	});

	it.each([
		['a different origin', { origin: 'https://evil.example' }],
		['a different RP ID', { rpId: 'other.example' }],
		['no user verification', { userVerified: false }],
	])('refuses a passkey made for %s', async (_label, overrides) => {
		const owner = await ownerSignIn();
		await reauthenticate(owner);
		const response = await registerPasskey(owner, authenticator, overrides);

		expect(response.status).toBe(400);
		expect(((await response.json()) as any).code).toBe('PASSKEY_VERIFY_FAILED');
		expect(await storedCredentials()).toHaveLength(0);
	});

	it('refuses a challenge that belongs to another session', async () => {
		const first = await ownerSignIn();
		await reauthenticate(first);
		const options = (await (await registerOptions(first)).json()) as any;

		const other = await ownerSignIn();
		await reauthenticate(other);
		const response = await registerVerify(other, { challenge: options.challenge, response: await authenticator.register(options) });
		expect(response.status).toBe(400);
		await response.text();
		expect(await storedCredentials()).toHaveLength(0);
	});

	it('is refused by the rate limit before a challenge is created', async () => {
		const owner = await ownerSignIn();
		await reauthenticate(owner);
		const refusing = { limit: async () => ({ success: false }) };
		const response = await registerOptions(owner, { ...env, AUTH_LIMITER: refusing } as unknown as Env);

		expect(response.status).toBe(429);
		expect(((await response.json()) as any).code).toBe('RATE_LIMITED');
		const challenges = await bucket().list({ prefix: CHALLENGE_PREFIX });
		expect(challenges.objects).toHaveLength(0);
	});

	it('keeps no separate passkey index, only the owner record', async () => {
		const owner = await ownerSignIn();
		await reauthenticate(owner);
		await registerPasskey(owner, authenticator);
		const keys = (await bucket().list({ prefix: 'auth/' })).objects.map((object) => object.key);
		expect(keys.some((key) => key.startsWith('auth/passkeys'))).toBe(false);
	});
});

describe('passkey challenges', () => {
	beforeAll(async () => {
		await resetStorage();
	});

	beforeEach(async () => {
		await setupTestEnvironment();
	});

	it('refuses a challenge after its expiry', async () => {
		const challenge = 'a'.repeat(43);
		await storeChallenge(bucket(), challenge, 'login', null, NOW);
		await expect(consumeChallenge(bucket(), challenge, 'login', null, NOW + 121)).rejects.toMatchObject({ status: 400 });
	});

	it('removes expired challenges during cleanup and keeps the ones still valid', async () => {
		const expired = 'b'.repeat(43);
		const live = 'c'.repeat(43);
		await storeChallenge(bucket(), expired, 'login', null, NOW);
		await storeChallenge(bucket(), live, 'login', null, NOW + 100);

		expect(await cleanupChallenges(bucket(), NOW + 130)).toBe(1);
		expect(await bucket().head(`${CHALLENGE_PREFIX}${await sha256Hex(live)}`)).not.toBeNull();
		expect(await bucket().head(`${CHALLENGE_PREFIX}${await sha256Hex(expired)}`)).toBeNull();
	});

	it('runs with the scheduled cleanup', async () => {
		await storeChallenge(bucket(), 'd'.repeat(43), 'login', null, NOW);
		const result = await cleanupExpired(bucket(), NOW + 3600);
		expect(result.challengesRemoved).toBe(1);
		expect(result.errors).toEqual([]);
	});

	it('rejects a malformed challenge value', async () => {
		await expect(consumeChallenge(bucket(), 'short', 'login', null, NOW)).rejects.toBeInstanceOf(ApiError);
	});
});
