import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { loginWithPassword } from '../src/worker/auth/login';
import { FAILURE_LIMIT, releaseAttempt, reserveAttempt, throttleKey } from '../src/worker/auth/throttle';
import { configureTotp } from './utils/security-helpers';
import { createOwnerOnce } from '../src/worker/auth/owner';
import { resetStorage, setupTestEnvironment, testFetch, TEST_ORIGIN, TEST_OWNER_PASSWORD } from './utils/test-setup';

const bucket = () => env.R2_STORAGE;
const SEED = new Uint8Array(20).map((_, index) => 70 + index);

function login(path: string, body: unknown) {
	// Every request comes from its own address: the owner-level limit must not depend on the client address
	return testFetch(`${TEST_ORIGIN}/api/auth/login/${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Origin: TEST_ORIGIN },
		body: JSON.stringify(body),
	});
}

async function statuses(responses: Response[]): Promise<number[]> {
	const out: number[] = [];
	for (const response of responses) {
		out.push(response.status);
		await response.text();
	}
	return out;
}

describe('R11 the guess budget is reserved before a guess is checked', () => {
	beforeEach(async () => {
		await resetStorage();
		await setupTestEnvironment();
		await createOwnerOnce(bucket(), TEST_OWNER_PASSWORD);
	});

	it('C14: 100 parallel wrong passwords from 100 addresses get at most five checks, and the rest are refused', async () => {
		const results = await statuses(
			await Promise.all(Array.from({ length: 100 }, () => login('password', { password: 'wrong-password-guess' }))),
		);

		const checked = results.filter((status) => status === 401).length;
		const refused = results.filter((status) => status === 429).length;
		expect(checked).toBeLessThanOrEqual(FAILURE_LIMIT);
		expect(checked + refused).toBe(100);

		// The method is locked afterwards, even for the right password
		const locked = await login('password', { password: TEST_OWNER_PASSWORD });
		expect(locked.status).toBe(429);
		expect(locked.headers.get('Retry-After')).toBeTruthy();
		await locked.text();
	});

	it('C14: 100 parallel wrong authenticator codes get at most five checks', async () => {
		await configureTotp(SEED, true);

		const results = await statuses(await Promise.all(Array.from({ length: 100 }, () => login('totp', { code: '000000' }))));

		expect(results.filter((status) => status === 401).length).toBeLessThanOrEqual(FAILURE_LIMIT);
		expect(results.filter((status) => status === 429).length).toBeGreaterThanOrEqual(95);
	});

	it('does not let the password limit use up the authenticator budget, or the reverse', async () => {
		await configureTotp(SEED, true);
		await statuses(await Promise.all(Array.from({ length: 30 }, () => login('password', { password: 'wrong-password-guess' }))));

		const totp = await login('totp', { code: '000000' });
		expect(totp.status).toBe(401);
		await totp.text();
	});

	it('lets the right password in as the fifth attempt after four failures', async () => {
		for (let i = 0; i < FAILURE_LIMIT - 1; i++) {
			expect((await login('password', { password: 'wrong-password-guess' })).status).toBe(401);
		}
		const response = await login('password', { password: TEST_OWNER_PASSWORD });
		expect(response.status).toBe(200);
		await response.text();
	});

	it('a successful sign-in clears the count, and a reservation is released whatever the outcome', async () => {
		await login('password', { password: 'wrong-password-guess' }).then((r) => r.text());
		await login('password', { password: TEST_OWNER_PASSWORD }).then((r) => r.text());

		const record = JSON.parse(await (await bucket().get(throttleKey('password')))!.text());
		expect(record.failureCount).toBe(0);
		expect(record.inflight ?? []).toEqual([]);
	});

	it('an attempt that ends in a server error gives its reservation back without counting as a guess', async () => {
		const broken = new Proxy(bucket(), {
			get(target, property) {
				if (property === 'get') {
					return (key: string, ...rest: unknown[]) =>
						key === 'auth/owner.json'
							? Promise.reject(new Error('injected R2 read failure'))
							: (target.get as any).call(target, key, ...rest);
				}
				const value = (target as any)[property];
				return typeof value === 'function' ? value.bind(target) : value;
			},
		}) as R2Bucket;

		await expect(loginWithPassword({ ...env, R2_STORAGE: broken } as never, TEST_OWNER_PASSWORD, 1_800_000_000)).rejects.toThrow();

		const record = JSON.parse(await (await bucket().get(throttleKey('password')))!.text());
		expect(record.failureCount).toBe(0);
		expect(record.inflight ?? []).toEqual([]);
	});

	it('a reservation that was never released expires, so a crashed request cannot block sign-in for ever', async () => {
		const now = 1_800_000_000;
		for (let i = 0; i < FAILURE_LIMIT; i++) await reserveAttempt(bucket(), 'password', now);
		await expect(reserveAttempt(bucket(), 'password', now)).rejects.toMatchObject({ status: 429 });

		await expect(reserveAttempt(bucket(), 'password', now + 120)).resolves.toBeTruthy();
	});

	it('releasing a reservation frees its place', async () => {
		const now = 1_800_000_000;
		const held: string[] = [];
		for (let i = 0; i < FAILURE_LIMIT; i++) held.push(await reserveAttempt(bucket(), 'password', now));
		await expect(reserveAttempt(bucket(), 'password', now)).rejects.toMatchObject({ status: 429 });

		await releaseAttempt(bucket(), 'password', held[0], now);
		await expect(reserveAttempt(bucket(), 'password', now)).resolves.toBeTruthy();
	});
});
