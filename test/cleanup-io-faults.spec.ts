import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { beginFinalize, createSessionRecord, getSessionRecord, reserveCandidateCode } from '../src/worker/session';
import { cleanupExpired, getChest } from '../src/worker/storage';
import { getCurrentTimestamp } from '../src/worker/utils';
import { resetStorage } from './utils/test-setup';

const bucket = () => env.R2_STORAGE;
const HOUR = 3600;
const pad = (n: number) => String(n).padStart(10, '0');

// A bucket whose reads of session records throw, as a transient R2 failure would
function sessionReadsFail(): R2Bucket {
	return new Proxy(bucket(), {
		get(target, property) {
			if (property === 'get') {
				return (key: string, ...rest: unknown[]) =>
					key.startsWith('sessions/')
						? Promise.reject(new Error('injected R2 read failure'))
						: (target.get as any).call(target, key, ...rest);
			}
			const value = (target as any)[property];
			return typeof value === 'function' ? value.bind(target) : value;
		},
	}) as R2Bucket;
}

async function keys(prefix: string): Promise<string[]> {
	return (await bucket().list({ prefix })).objects.map((o) => o.key);
}

async function completedChest(code: string, expiresAt: number, now: number) {
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
			candidateCode: code,
			retrievalCode: code,
			validityDays: 7,
			expiresAt,
			fileIds: [fileId],
		}),
	);
	await bucket().put(`codes/${code}`, JSON.stringify({ version: 1, sessionId, createdAt: now, expiresAt, files: [file] }));
	return { sessionId, fileId };
}

describe('R01/R02 a failed read is not a missing session', () => {
	beforeEach(resetStorage);

	it('C01: keeps a live chest and its index when the session cannot be read, and reports it', async () => {
		const now = getCurrentTimestamp();
		const chest = await completedChest('ABC123', now + 200, now);
		await bucket().put(`expiry/${pad(now - 100)}/ABC123`, ''); // stale leftover index, already due

		const result = await cleanupExpired(sessionReadsFail(), now);

		expect(result.errors.length).toBeGreaterThan(0);
		expect(await bucket().head('codes/ABC123')).not.toBeNull();
		expect(await bucket().head(`expiry/${pad(now - 100)}/ABC123`)).not.toBeNull();
		expect(await bucket().head(`${chest.sessionId}/${chest.fileId}`)).not.toBeNull();
		expect(await getChest(bucket(), 'ABC123', now)).not.toBeNull();

		// Once reads work again the leftover index is repaired and the chest is still there
		const retry = await cleanupExpired(bucket(), now);
		expect(retry.errors.filter((e) => !/disagreed/.test(e))).toEqual([]);
		expect(await bucket().head('codes/ABC123')).not.toBeNull();
		expect(await bucket().head(`${chest.sessionId}/${chest.fileId}`)).not.toBeNull();
	});

	it('C04: a session that is really missing still lets the orphan index and claim go', async () => {
		const now = getCurrentTimestamp();
		const live = await completedChest('LIVE01', now + 200, now);
		await bucket().put(
			'codes/GONE01',
			JSON.stringify({ version: 1, sessionId: crypto.randomUUID(), createdAt: now, expiresAt: now - 5, files: [] }),
		);
		await bucket().put(`expiry/${pad(now - 5)}/GONE01`, '');

		const result = await cleanupExpired(bucket(), now);

		expect(result.orphanClaims).toBe(1);
		expect(await bucket().head('codes/GONE01')).toBeNull();
		expect(await bucket().head('codes/LIVE01')).not.toBeNull();
		expect(await bucket().head(`${live.sessionId}/${live.fileId}`)).not.toBeNull();
	});

	it('C02: keeps an overdue pending marker when the session cannot be read, then reclaims it', async () => {
		const now = getCurrentTimestamp();
		const sessionId = crypto.randomUUID();
		const fileId = crypto.randomUUID();
		const createdAt = now - 49 * HOUR;
		await createSessionRecord(bucket(), { sessionId, createdAt });
		await bucket().put(`${sessionId}/${fileId}`, 'x');
		await bucket().put(`pending/${pad(createdAt)}/${sessionId}`, '');

		const failed = await cleanupExpired(sessionReadsFail(), now);

		expect(failed.errors.length).toBeGreaterThan(0);
		expect(await keys('pending/')).toHaveLength(1);
		expect(await bucket().head(`${sessionId}/${fileId}`)).not.toBeNull();

		const retry = await cleanupExpired(bucket(), now);
		expect(retry.abandonedSessions).toBe(1);
		expect(await keys('pending/')).toEqual([]);
		expect(await bucket().head(`${sessionId}/${fileId}`)).toBeNull();
	});

	it('C03: keeps a stuck finalizing marker when the session cannot be read, then recovers it', async () => {
		const now = getCurrentTimestamp();
		const sessionId = crypto.randomUUID();
		const startedAt = now - 2 * HOUR;
		await createSessionRecord(bucket(), { sessionId, createdAt: now - 3 * HOUR });
		await beginFinalize(bucket(), sessionId, 'fp|7', startedAt, { validityDays: 7, expiresAt: now + 86400 });
		await reserveCandidateCode(bucket(), sessionId, 'ZZZ999');
		await bucket().put(`finalizing/${pad(startedAt)}/${sessionId}`, '');

		const failed = await cleanupExpired(sessionReadsFail(), now);

		expect(failed.errors.length).toBeGreaterThan(0);
		expect(await keys('finalizing/')).toHaveLength(1);
		expect((await getSessionRecord(bucket(), sessionId))!.record.status).toBe('FINALIZING');

		const retry = await cleanupExpired(bucket(), now);
		expect(retry.rolledBackFinalizations).toBe(1);
		expect(await keys('finalizing/')).toEqual([]);
	});

	it('fails closed on a corrupt session record: nothing is deleted and the error is reported', async () => {
		const now = getCurrentTimestamp();
		const chest = await completedChest('BAD001', now + 200, now);
		await bucket().put(`sessions/${chest.sessionId}`, '{"not":"a session"}');
		await bucket().put(`expiry/${pad(now - 1)}/BAD001`, '');

		const result = await cleanupExpired(bucket(), now);

		expect(result.errors.length).toBeGreaterThan(0);
		expect(await bucket().head('codes/BAD001')).not.toBeNull();
		expect(await bucket().head(`expiry/${pad(now - 1)}/BAD001`)).not.toBeNull();
		expect(await bucket().head(`${chest.sessionId}/${chest.fileId}`)).not.toBeNull();
	});
});
