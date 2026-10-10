import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { createOwnerOnce } from '../src/worker/auth/owner';
import { FAILURE_LIMIT, reserveAttempt } from '../src/worker/auth/throttle';
import {
	createTestSession,
	resetStorage,
	setupTestEnvironment,
	testFetch,
	TEST_ORIGIN,
	TEST_OWNER_PASSWORD,
	postRetrieve,
} from './utils/test-setup';
import type { RateLimitBinding } from '../src/worker/types';

const original = env.R2_STORAGE;
const THROTTLE = 'auth/throttle/password.json';

function login(password: string) {
	return testFetch(`${TEST_ORIGIN}/api/auth/login/password`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Origin: TEST_ORIGIN },
		body: JSON.stringify({ password }),
	});
}

function countingPuts(key: string): { bucket: R2Bucket; puts: () => number } {
	let count = 0;
	const bucket = new Proxy(original, {
		get(target, property) {
			if (property === 'put') {
				return (k: string, ...rest: unknown[]) => {
					if (k === key) count++;
					return (target.put as any).call(target, k, ...rest);
				};
			}
			const value = (target as any)[property];
			return typeof value === 'function' ? value.bind(target) : value;
		},
	}) as R2Bucket;
	return { bucket, puts: () => count };
}

describe('N2-10 refused attempts cost no writes', () => {
	beforeEach(async () => {
		await resetStorage();
		await setupTestEnvironment();
		await createOwnerOnce(original, TEST_OWNER_PASSWORD);
	});

	it('50 attempts against a locked method write nothing to the counter', async () => {
		for (let i = 0; i < FAILURE_LIMIT; i++) await (await login('wrong-password-guess')).text();
		const locked = await login(TEST_OWNER_PASSWORD);
		expect(locked.status).toBe(429);
		await locked.text();

		const spy = countingPuts(THROTTLE);
		Object.defineProperty(env, 'R2_STORAGE', { value: spy.bucket, configurable: true });
		try {
			const responses = await Promise.all(Array.from({ length: 50 }, () => login('wrong-password-guess')));
			for (const response of responses) {
				expect(response.status).toBe(429);
				await response.text();
			}
		} finally {
			Object.defineProperty(env, 'R2_STORAGE', { value: original, configurable: true });
		}

		expect(spy.puts()).toBe(0);
	});

	it('a full budget is refused without writing either, and the lock still holds afterwards', async () => {
		const now = Math.floor(Date.now() / 1000);
		for (let i = 0; i < FAILURE_LIMIT; i++) await reserveAttempt(original, 'password', now);
		const spy = countingPuts(THROTTLE);

		for (let i = 0; i < 20; i++) await expect(reserveAttempt(spy.bucket, 'password', now)).rejects.toMatchObject({ status: 429 });

		expect(spy.puts()).toBe(0);
	});

	it('a normal attempt still takes its place with a write, so the budget stays exact', async () => {
		const spy = countingPuts(THROTTLE);
		await reserveAttempt(spy.bucket, 'password', Math.floor(Date.now() / 1000));
		expect(spy.puts()).toBe(1);
	});
});

describe('N2-10 downloads are limited per file and address', () => {
	beforeEach(async () => {
		await resetStorage();
		await setupTestEnvironment();
	});

	it('answers 429 when the download limiter refuses, and 200 when it does not', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const form = new FormData();
		form.append('textItems', JSON.stringify({ content: 'hello', filename: 'a.txt' }));
		const upload = (await (
			await testFetch(`http://example.com/api/upload-sessions/${sessionId}/files`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${uploadToken}` },
				body: form,
			})
		).json()) as any;
		const fileId = upload.uploadedFiles[0].fileId as string;
		const done = (await (
			await testFetch(`http://example.com/api/upload-sessions/${sessionId}/complete`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${uploadToken}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ fileIds: [fileId], validityDays: 7 }),
			})
		).json()) as any;
		const { chestToken } = (await (await postRetrieve(done.retrievalCode)).json()) as any;
		const authorized = await testFetch('http://example.com/api/download/authorize', {
			method: 'POST',
			headers: { Authorization: `Bearer ${chestToken}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ fileId }),
		});
		const cookie = (authorized.headers.get('Set-Cookie') ?? '').split(';')[0];
		await authorized.text();

		const keys: string[] = [];
		const saved = (env as any).DOWNLOAD_LIMITER;
		const refusing: RateLimitBinding = {
			limit: async ({ key }) => {
				keys.push(key);
				return { success: false };
			},
		};
		Object.defineProperty(env, 'DOWNLOAD_LIMITER', { value: refusing, configurable: true });
		try {
			const refused = await testFetch(`http://example.com/api/download/${fileId}`, {
				headers: { Cookie: cookie, 'CF-Connecting-IP': '203.0.113.77' },
			});
			expect(refused.status).toBe(429);
			await refused.text();
		} finally {
			Object.defineProperty(env, 'DOWNLOAD_LIMITER', { value: saved, configurable: true });
		}
		expect(keys).toEqual([`test-instance:download:${fileId}:203.0.113.77`]);

		const ok = await testFetch(`http://example.com/api/download/${fileId}`, { headers: { Cookie: cookie } });
		expect(ok.status).toBe(200);
		expect(await ok.text()).toBe('hello');
	});
});
