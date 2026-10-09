import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { getSessionRecord } from '../src/worker/session';
import { cleanupExpired } from '../src/worker/storage';
import { resetStorage, setupTestEnvironment, createTestSession, testFetch } from './utils/test-setup';

const bucket = () => env.R2_STORAGE;
const T0 = 1_800_000_000;

async function upload(sessionId: string, uploadToken: string): Promise<string> {
	const formData = new FormData();
	formData.append('textItems', JSON.stringify({ content: 'one', filename: 'one.txt' }));
	const response = await testFetch(`http://example.com/api/upload-sessions/${sessionId}/files`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${uploadToken}` },
		body: formData,
	});
	return ((await response.json()) as any).uploadedFiles[0].fileId;
}

function complete(sessionId: string, uploadToken: string, fileIds: string[], validityDays: number) {
	return testFetch(`http://example.com/api/upload-sessions/${sessionId}/complete`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${uploadToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ fileIds, validityDays }),
	});
}

// Fails the first write to the session record that marks it COMPLETED
function failCompletedOnce(): R2Bucket {
	let failed = false;
	return new Proxy(bucket(), {
		get(target, property) {
			if (property === 'put') {
				return async (key: string, value: unknown, ...rest: unknown[]) => {
					if (!failed && key.startsWith('sessions/') && typeof value === 'string' && value.includes('"status":"COMPLETED"')) {
						failed = true;
						throw new Error('injected failure');
					}
					return (target.put as any).call(target, key, value, ...rest);
				};
			}
			const value = (target as any)[property];
			return typeof value === 'function' ? value.bind(target) : value;
		},
	}) as R2Bucket;
}

describe('FIX-01 completion expiry is fixed at the start of completion', () => {
	beforeEach(async () => {
		await resetStorage();
		await setupTestEnvironment();
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(T0 * 1000);
	});
	afterEach(() => vi.useRealTimers());

	it('keeps session, manifest, expiry index and response on one expiry after a retry 1800s later', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const fileId = await upload(sessionId, uploadToken);

		// First attempt: stop right after the code was claimed and the expiry index written
		const original = env.R2_STORAGE;
		const proxied = failCompletedOnce();
		Object.defineProperty(env, 'R2_STORAGE', { value: proxied, configurable: true });
		const first = await complete(sessionId, uploadToken, [fileId], 1);
		Object.defineProperty(env, 'R2_STORAGE', { value: original, configurable: true });
		expect(first.status).toBe(500);

		vi.setSystemTime((T0 + 1800) * 1000);
		const retry = await complete(sessionId, uploadToken, [fileId], 1);
		expect(retry.status).toBe(200);
		const body = (await retry.json()) as any;

		const session = (await getSessionRecord(bucket(), sessionId))!.record;
		const manifest = (await (await bucket().get(`codes/${body.retrievalCode}`))!.json()) as any;
		const indexKeys = (await bucket().list({ prefix: 'expiry/' })).objects.map((o) => o.key);

		const expected = T0 + 86400;
		expect(session.expiresAt).toBe(expected);
		expect(manifest.expiresAt).toBe(expected);
		expect(Date.parse(body.expiryDate) / 1000).toBe(expected);
		expect(indexKeys).toEqual([`expiry/${String(expected).padStart(10, '0')}/${body.retrievalCode}`]);

		// Cron before the real expiry removes nothing; after it, everything goes
		const early = await cleanupExpired(bucket(), expected - 1);
		expect(early.expiredChests).toBe(0);
		expect(await bucket().head(`${sessionId}/${fileId}`)).not.toBeNull();
		const late = await cleanupExpired(bucket(), expected);
		expect(late.expiredChests).toBe(1);
		expect(await bucket().head(`${sessionId}/${fileId}`)).toBeNull();
	});

	it('does not delete files when the expiry index disagrees with the session, and repairs the manifest', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const fileId = await upload(sessionId, uploadToken);
		const body = (await (await complete(sessionId, uploadToken, [fileId], 1)).json()) as any;
		const code = body.retrievalCode as string;
		const expected = T0 + 86400;

		// Corrupt the state like the old bug did: an index and manifest earlier than the session's expiry
		const early = expected - 1800;
		const manifest = (await (await bucket().get(`codes/${code}`))!.json()) as any;
		await bucket().put(`codes/${code}`, JSON.stringify({ ...manifest, expiresAt: early }));
		await bucket().put(`expiry/${String(early).padStart(10, '0')}/${code}`, '');

		const result = await cleanupExpired(bucket(), early + 1);

		expect(result.expiredChests).toBe(0);
		expect(await bucket().head(`${sessionId}/${fileId}`)).not.toBeNull();
		const repaired = (await (await bucket().get(`codes/${code}`))!.json()) as any;
		expect(repaired.expiresAt).toBe(expected);
		const keys = (await bucket().list({ prefix: 'expiry/' })).objects.map((o) => o.key);
		expect(keys).toEqual([`expiry/${String(expected).padStart(10, '0')}/${code}`]);
	});
});
