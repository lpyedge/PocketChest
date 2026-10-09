import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import worker from '../src/worker/index';
import { cleanupExpired } from '../src/worker/storage';
import { getCurrentTimestamp } from '../src/worker/utils';
import { resetStorage } from './utils/test-setup';

const bucket = () => env.R2_STORAGE;
const pad = (n: number) => String(n).padStart(10, '0');
const CODE = 'ABC123';

async function completedChest(now: number, expiresAt: number) {
	const sessionId = crypto.randomUUID();
	const fileId = crypto.randomUUID();
	const file = { fileId, filename: 'a.txt', size: 1, mimeType: 'text/plain', isText: true, fileExtension: 'txt' };
	await bucket().put(`${sessionId}/${fileId}`, 'a');
	await bucket().put(
		`sessions/${sessionId}`,
		JSON.stringify({
			version: 1,
			sessionId,
			status: 'COMPLETED',
			createdAt: now,
			leases: [],
			files: [file],
			multipartUploads: [],
			completionFingerprint: `${fileId}|7`,
			finalizeStartedAt: now,
			candidateCode: CODE,
			retrievalCode: CODE,
			validityDays: 7,
			expiresAt,
			fileIds: [fileId],
		}),
	);
	await bucket().put(`codes/${CODE}`, JSON.stringify({ version: 1, sessionId, createdAt: now, expiresAt, files: [file] }));
	return sessionId;
}

// The error R2 throws names the key it was working on, which for these keys contains the retrieval code
function deletesFail(): R2Bucket {
	return new Proxy(bucket(), {
		get(target, property) {
			if (property === 'delete') {
				return (keys: string | string[]) => {
					const first = Array.isArray(keys) ? keys[0] : keys;
					return Promise.reject(new Error(`R2 delete failed for ${first}`));
				};
			}
			const value = (target as any)[property];
			return typeof value === 'function' ? value.bind(target) : value;
		},
	}) as R2Bucket;
}

describe('R06 cleanup output never contains a retrieval code', () => {
	const lines: string[] = [];
	beforeEach(async () => {
		await resetStorage();
		lines.length = 0;
		for (const method of ['log', 'warn', 'error'] as const) {
			vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void lines.push(args.map(String).join(' ')));
		}
	});
	afterEach(() => vi.restoreAllMocks());

	it('C12: an expiry mismatch that is repaired is reported without the code', async () => {
		const now = getCurrentTimestamp();
		await completedChest(now, now + 1000);
		await bucket().put(`expiry/${pad(now - 5)}/${CODE}`, '');

		const result = await cleanupExpired(bucket(), now);

		expect(result.repairedExpiry).toBe(1);
		expect(result.errors.length).toBeGreaterThan(0);
		expect(JSON.stringify(result)).not.toContain(CODE);
	});

	it('C12: a failing delete is reported without the code, in the result and in the scheduled job output', async () => {
		const now = getCurrentTimestamp();
		const sessionId = await completedChest(now, now - 10);
		await bucket().put(`expiry/${pad(now - 10)}/${CODE}`, '');

		const result = await cleanupExpired(deletesFail(), now);
		expect(result.errors.length).toBeGreaterThan(0);
		expect(JSON.stringify(result)).not.toContain(CODE);
		// Still traceable: by the session, which is not a secret
		expect(result.errors.join(' ')).toContain(sessionId);

		const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
		await worker.scheduled({} as ScheduledController, { ...env, R2_STORAGE: deletesFail() } as never, ctx).catch(() => undefined);
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.join('\n')).not.toContain(CODE);
	});

	it('C12: a failure before the session is known does not name the code either', async () => {
		const now = getCurrentTimestamp();
		await bucket().put(`expiry/${pad(now - 10)}/${CODE}`, '');
		const broken = new Proxy(bucket(), {
			get(target, property) {
				if (property === 'get') return (key: string) => Promise.reject(new Error(`R2 get failed for ${key}`));
				const value = (target as any)[property];
				return typeof value === 'function' ? value.bind(target) : value;
			},
		}) as R2Bucket;

		const result = await cleanupExpired(broken, now);

		expect(result.errors.length).toBeGreaterThan(0);
		expect(JSON.stringify(result)).not.toContain(CODE);
	});
});

describe('redactSecrets', () => {
	it('masks codes in storage keys, bearer tokens and owner cookies, and leaves ordinary text alone', async () => {
		const { redactSecrets } = await import('../src/worker/utils');
		expect(redactSecrets('failed codes/ABC123 and expiry/0001800000/XYZ789 now')).toBe(
			'failed codes/[hidden] and expiry/0001800000/[hidden] now',
		);
		expect(redactSecrets('Authorization: Bearer abc.def-ghi_123')).toBe('Authorization: Bearer [hidden]');
		expect(redactSecrets('Cookie: __Host-pc_owner=secretvalue; Path=/')).toBe('Cookie: __Host-pc_owner=[hidden]; Path=/');
		expect(redactSecrets('Session 123e4567-e89b-12d3-a456-426614174000 failed')).toBe(
			'Session 123e4567-e89b-12d3-a456-426614174000 failed',
		);
	});
});
