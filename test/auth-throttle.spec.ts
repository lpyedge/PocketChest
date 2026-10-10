import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import worker from '../src/worker/index';
import {
	ownerSignIn,
	resetStorage,
	setupTestEnvironment,
	testFetch,
	TEST_ORIGIN,
	TEST_OWNER_PASSWORD,
	objectText,
	TEST_JWT_SECRET,
} from './utils/test-setup';
import { loginWithPassword, loginWithTotp } from '../src/worker/auth/login';
import { mutateOwner } from '../src/worker/auth/owner';
import { sealSeed, totpCodeAt } from '../src/worker/auth/totp';
import { cleanupThrottles, FAILURE_LIMIT, throttleKey } from '../src/worker/auth/throttle';
import { cleanupExpired } from '../src/worker/storage';
import { ApiError } from '../src/worker/errors';
import type { Env, RateLimitBinding } from '../src/worker/types';

const bucket = () => env.R2_STORAGE;
// The test environment carries the bindings from vitest.config.mts; its generated type does not list them
const bindings = env as unknown as Env;
const NOW = 1_800_000_000;
const WRONG = 'not-the-owner-password';
const SEED = new Uint8Array(20).map((_, index) => 40 + index);
const OTHER_SEED = new Uint8Array(20).fill(0x33);

async function failureOf(promise: Promise<unknown>): Promise<ApiError> {
	const outcome = await promise.then(
		() => null,
		(caught: unknown) => caught,
	);
	expect(outcome).toBeInstanceOf(ApiError);
	return outcome as ApiError;
}

// Five wrong passwords at `now`, which trips the lock on the attempt after them
async function failPassword(now: number, times = FAILURE_LIMIT) {
	for (let i = 0; i < times; i++) {
		expect((await failureOf(loginWithPassword(env, WRONG, now))).status).toBe(401);
	}
}

async function enableTotpAndPassword(seed: Uint8Array) {
	const sealed = await sealSeed(seed, TEST_JWT_SECRET);
	await mutateOwner(bucket(), (owner) => ({
		...owner,
		methods: {
			password: owner.methods.password,
			totp: { enabled: true, encryptedSecret: sealed, lastAcceptedStep: null },
			passkey: owner.methods.passkey,
		},
	}));
}

function postPassword(password: string, ip: string, environment: Env = env as unknown as Env) {
	const ctx = createExecutionContext();
	const request = new Request(`${TEST_ORIGIN}/api/auth/login/password`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Origin: TEST_ORIGIN, 'CF-Connecting-IP': ip },
		body: JSON.stringify({ password }),
	});
	return worker.fetch(request, environment, ctx).then(async (response) => {
		await waitOnExecutionContext(ctx);
		return response;
	});
}

describe('owner-level lockout per sign-in method', () => {
	beforeAll(async () => {
		await resetStorage();
	});

	beforeEach(async () => {
		await setupTestEnvironment();
		await ownerSignIn();
	});

	it('locks the password after five wrong attempts, and refuses even the right password until the cooldown ends', async () => {
		await failPassword(NOW);

		const locked = await failureOf(loginWithPassword(env, TEST_OWNER_PASSWORD, NOW + 5));
		expect(locked.status).toBe(429);
		expect(locked.code).toBe('AUTH_TEMPORARILY_LOCKED');
		expect(locked.headers['Retry-After']).toBe('55');
	});

	it('accepts the right password again once the cooldown has passed', async () => {
		await failPassword(NOW);
		await expect(loginWithPassword(env, TEST_OWNER_PASSWORD, NOW + 60)).resolves.toMatchObject({ csrfToken: expect.any(String) });
	});

	it('escalates for repeat offenders, one minute first and fifteen minutes at most', async () => {
		let now = NOW;
		for (let lock = 1; lock <= 6; lock++) {
			await failPassword(now);
			const cooldown = Math.min(60 * 2 ** (lock - 1), 15 * 60);
			const refused = await failureOf(loginWithPassword(env, TEST_OWNER_PASSWORD, now + 1));
			expect(refused.status).toBe(429);
			expect(refused.headers['Retry-After']).toBe(String(cooldown - 1));
			now += cooldown;
		}
	});

	it('does not extend a running lock when more wrong attempts arrive during it', async () => {
		await failPassword(NOW);
		await failureOf(loginWithPassword(env, WRONG, NOW + 10));
		const refused = await failureOf(loginWithPassword(env, TEST_OWNER_PASSWORD, NOW + 11));
		expect(refused.headers['Retry-After']).toBe('49');
	});

	it('clears the count when the password succeeds, so earlier failures do not add up', async () => {
		await failPassword(NOW, FAILURE_LIMIT - 1);
		await loginWithPassword(env, TEST_OWNER_PASSWORD, NOW + 1);
		await failPassword(NOW + 2, FAILURE_LIMIT - 1);

		await expect(loginWithPassword(env, TEST_OWNER_PASSWORD, NOW + 3)).resolves.toBeDefined();
	});

	it('does not count failures that fall outside the five-minute window', async () => {
		await failPassword(NOW, FAILURE_LIMIT - 1);
		await failureOf(loginWithPassword(env, WRONG, NOW + 5 * 60 + 1));
		await expect(loginWithPassword(env, TEST_OWNER_PASSWORD, NOW + 5 * 60 + 2)).resolves.toBeDefined();
	});

	it('leaves the authenticator usable while the password is locked, and the other way round', async () => {
		await enableTotpAndPassword(SEED);
		await failPassword(NOW);

		// The password is locked for a minute; the authenticator is not
		await expect(loginWithTotp(env, await totpCodeAt(SEED, NOW + 10), NOW + 10)).resolves.toBeDefined();
		expect((await failureOf(loginWithPassword(env, TEST_OWNER_PASSWORD, NOW + 11))).status).toBe(429);

		// Later, the authenticator is locked by five wrong codes; the password, now unlocked, still works
		const later = NOW + 200;
		for (let i = 0; i < FAILURE_LIMIT; i++) {
			expect((await failureOf(loginWithTotp(env, await totpCodeAt(OTHER_SEED, later + i), later + i))).status).toBe(401);
		}
		expect((await failureOf(loginWithTotp(env, await totpCodeAt(SEED, later + 5), later + 5))).status).toBe(429);
		await expect(loginWithPassword(env, TEST_OWNER_PASSWORD, later + 6)).resolves.toBeDefined();
	});

	it('keeps the lock when the client address changes', async () => {
		for (let i = 0; i < FAILURE_LIMIT; i++) {
			expect((await postPassword(WRONG, `203.0.113.${i + 1}`)).status).toBe(401);
		}
		// A new address, and even the correct password, is refused: the counter belongs to the owner
		const response = await postPassword(TEST_OWNER_PASSWORD, '203.0.113.99');
		expect(response.status).toBe(429);
		expect(((await response.json()) as any).code).toBe('AUTH_TEMPORARILY_LOCKED');
		expect(response.headers.get('Retry-After')).not.toBeNull();
	});

	it('answers a lock with 429 and Retry-After over HTTP', async () => {
		for (let i = 0; i < FAILURE_LIMIT; i++) {
			await (
				await testFetch(`${TEST_ORIGIN}/api/auth/login/password`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', Origin: TEST_ORIGIN, 'CF-Connecting-IP': '203.0.113.5' },
					body: JSON.stringify({ password: WRONG }),
				})
			).text();
		}
		const response = await postPassword(TEST_OWNER_PASSWORD, '203.0.113.5');
		expect(response.status).toBe(429);
		await response.text();
	});
});

describe('runtime rate limit bindings', () => {
	beforeAll(async () => {
		await resetStorage();
	});

	beforeEach(async () => {
		await setupTestEnvironment();
		await ownerSignIn();
	});

	function refusing(): RateLimitBinding {
		return { limit: async () => ({ success: false }) };
	}

	it('calls the binding with a key per route and client address', async () => {
		const keys: string[] = [];
		const counting: RateLimitBinding = {
			limit: async (options) => {
				keys.push(options.key);
				return (bindings.AUTH_LIMITER as RateLimitBinding).limit(options);
			},
		};
		await postPassword(TEST_OWNER_PASSWORD, '203.0.113.20', { ...env, AUTH_LIMITER: counting } as unknown as Env);
		expect(keys).toEqual(['test-instance:login-password:203.0.113.20']);
	});

	it('answers 429 with Retry-After when the limiter refuses, without counting a failure', async () => {
		const response = await postPassword(TEST_OWNER_PASSWORD, '203.0.113.21', { ...env, AUTH_LIMITER: refusing() } as unknown as Env);
		expect(response.status).toBe(429);
		expect(((await response.json()) as any).code).toBe('RATE_LIMITED');
		expect(response.headers.get('Retry-After')).toBe('60');
		const stored = await bucket().get(throttleKey('password'));
		expect(stored ? JSON.parse(await stored.text()).failureCount : 0).toBe(0);
	});

	it('fails closed when the limiter binding is missing', async () => {
		const response = await postPassword(TEST_OWNER_PASSWORD, '203.0.113.22', { ...env, AUTH_LIMITER: undefined } as unknown as Env);
		expect(response.status).toBe(500);
		await response.text();
	});

	it('limits retrieval and upload session creation as well', async () => {
		const retrieve = await worker.fetch(
			new Request(`${TEST_ORIGIN}/api/retrieve`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Origin: TEST_ORIGIN },
				body: JSON.stringify({ code: 'ABC123' }),
			}),
			{ ...env, RETRIEVE_LIMITER: refusing() } as unknown as Env,
			createExecutionContext(),
		);
		expect(retrieve.status).toBe(429);
		await retrieve.text();

		const owner = await ownerSignIn();
		const create = await worker.fetch(
			new Request(`${TEST_ORIGIN}/api/upload-sessions`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Origin: TEST_ORIGIN, Cookie: owner.cookie, 'X-PocketChest-CSRF': owner.csrfToken },
				body: '{}',
			}),
			{ ...env, UPLOAD_LIMITER: refusing() } as unknown as Env,
			createExecutionContext(),
		);
		expect(create.status).toBe(429);
		await create.text();
	});
});

describe('cleanup of sign-in counters', () => {
	beforeAll(async () => {
		await resetStorage();
	});

	beforeEach(async () => {
		await setupTestEnvironment();
		await ownerSignIn();
	});

	const quietSince = NOW - 48 * 60 * 60;

	it('resets quiet, unlocked counters and keeps the ones that are still locked or recent', async () => {
		await bucket().put(
			throttleKey('password'),
			JSON.stringify({ version: 1, windowStart: null, failureCount: 0, blockedUntil: NOW + 100, strikes: 3, lastActivityAt: quietSince }),
		);
		await bucket().put(
			throttleKey('totp'),
			JSON.stringify({ version: 1, windowStart: null, failureCount: 2, blockedUntil: null, strikes: 1, lastActivityAt: quietSince }),
		);

		const reset = await cleanupThrottles(bucket(), NOW);
		expect(reset).toBe(1);

		// The running lock survives the cleanup, so the cleanup cannot be used to shorten it
		const password = JSON.parse(await await objectText(throttleKey('password')));
		expect(password).toMatchObject({ blockedUntil: NOW + 100, strikes: 3 });
		const totp = JSON.parse(await await objectText(throttleKey('totp')));
		expect(totp).toMatchObject({ failureCount: 0, strikes: 0, blockedUntil: null });
	});

	it('is part of the scheduled cleanup run', async () => {
		await bucket().put(
			throttleKey('totp'),
			JSON.stringify({ version: 1, windowStart: null, failureCount: 4, blockedUntil: null, strikes: 2, lastActivityAt: quietSince }),
		);
		const result = await cleanupExpired(bucket(), NOW);
		expect(result.throttlesReset).toBe(1);
		expect(result.errors).toEqual([]);
	});

	it('refuses to act on a counter it cannot read, instead of resetting it', async () => {
		await bucket().put(throttleKey('password'), '{"version":1,"blockedUntil":"soon"}');
		await expect(cleanupThrottles(bucket(), NOW)).rejects.toThrow();
		expect(await await objectText(throttleKey('password'))).toContain('soon');
	});
});
