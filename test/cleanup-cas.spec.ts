import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { createSessionRecord, getSessionRecord } from '../src/worker/session';
import { cleanupExpired } from '../src/worker/storage';
import { getCurrentTimestamp } from '../src/worker/utils';
import { resetStorage } from './utils/test-setup';

const original = env.R2_STORAGE;
const bucket = () => original;
const HOUR = 3600;
const pad = (n: number) => String(n).padStart(10, '0');

async function overdueSession() {
	const now = getCurrentTimestamp();
	const sessionId = crypto.randomUUID();
	const fileId = crypto.randomUUID();
	const createdAt = now - 49 * HOUR;
	await createSessionRecord(bucket(), { sessionId, createdAt });
	await bucket().put(`${sessionId}/${fileId}`, 'content');
	await bucket().put(`pending/${pad(createdAt)}/${sessionId}`, '');
	return { now, sessionId, fileId, createdAt };
}

// Runs `before` once, just before the first write to the session record: the point where cleanup tries to take it over
function racing(sessionId: string, before: () => Promise<void>): R2Bucket {
	let fired = false;
	return new Proxy(original, {
		get(target, property) {
			if (property === 'put') {
				return async (key: string, ...rest: unknown[]) => {
					if (!fired && key === `sessions/${sessionId}`) {
						fired = true;
						await before();
					}
					return (target.put as any).call(target, key, ...rest);
				};
			}
			const value = (target as any)[property];
			return typeof value === 'function' ? value.bind(target) : value;
		},
	}) as R2Bucket;
}

// What Complete would have written, directly: the public API cannot finish a session this old, so the race is staged
async function completeBehindTheScenes(sessionId: string, fileId: string, code: string, createdAt: number) {
	const { record } = (await getSessionRecord(bucket(), sessionId))!;
	const file = { fileId, filename: 'a.txt', size: 7, mimeType: 'text/plain', isText: true, fileExtension: 'txt' };
	await bucket().put(
		`sessions/${sessionId}`,
		JSON.stringify({
			...record,
			status: 'COMPLETED',
			files: [file],
			retrievalCode: code,
			validityDays: -1,
			expiresAt: null,
			fileIds: [fileId],
		}),
	);
	await bucket().put(`codes/${code}`, JSON.stringify({ version: 1, sessionId, createdAt, expiresAt: null, files: [file] }));
}

describe('N2-04 cleanup takes the session over with a compare-and-swap before it deletes anything', () => {
	beforeEach(resetStorage);

	it('T03: a Complete that wins the race keeps its content and its code', async () => {
		const { now, sessionId, fileId, createdAt } = await overdueSession();
		const cron = racing(sessionId, () => completeBehindTheScenes(sessionId, fileId, 'WIN123', createdAt));

		const result = await cleanupExpired(cron, now);

		expect(result.abandonedSessions).toBe(0);
		expect((await getSessionRecord(bucket(), sessionId))!.record.status).toBe('COMPLETED');
		expect(await bucket().head(`${sessionId}/${fileId}`)).not.toBeNull();
		expect(await bucket().head('codes/WIN123')).not.toBeNull();
		// The marker is only an index entry once the session is complete
		expect((await bucket().list({ prefix: 'pending/' })).objects).toEqual([]);

		// A later run, and the orphan scan, leave it alone as well
		const again = await cleanupExpired(bucket(), now + 100 * HOUR);
		expect(again.errors).toEqual([]);
		expect(await bucket().head(`${sessionId}/${fileId}`)).not.toBeNull();
	});

	it('T03: a session that moves to FINALIZING in between is left to the completion', async () => {
		const { now, sessionId, fileId } = await overdueSession();
		const cron = racing(sessionId, async () => {
			const { record } = (await getSessionRecord(bucket(), sessionId))!;
			await bucket().put(
				`sessions/${sessionId}`,
				JSON.stringify({ ...record, status: 'FINALIZING', finalizeStartedAt: now, completionFingerprint: 'fp|7' }),
			);
		});

		const result = await cleanupExpired(cron, now);

		expect(result.abandonedSessions).toBe(0);
		expect((await getSessionRecord(bucket(), sessionId))!.record.status).toBe('FINALIZING');
		expect(await bucket().head(`${sessionId}/${fileId}`)).not.toBeNull();
	});

	it('T04: an abandoned session is removed even when a delete fails once, and the next run finishes it', async () => {
		const { now, sessionId, fileId } = await overdueSession();
		let failed = false;
		const flaky = new Proxy(original, {
			get(target, property) {
				if (property === 'delete') {
					return (keys: string | string[]) => {
						if (!failed) {
							failed = true;
							return Promise.reject(new Error('injected delete failure'));
						}
						return (target.delete as any).call(target, keys);
					};
				}
				const value = (target as any)[property];
				return typeof value === 'function' ? value.bind(target) : value;
			},
		}) as R2Bucket;

		const first = await cleanupExpired(flaky, now);
		expect(first.errors.length).toBeGreaterThan(0);
		// Taken over, not deleted: nothing can complete it any more, and the marker stays for the retry
		expect((await getSessionRecord(bucket(), sessionId))?.record.status).toBe('ABANDONED');
		expect((await bucket().list({ prefix: 'pending/' })).objects).toHaveLength(1);

		const second = await cleanupExpired(bucket(), now);
		expect(second.errors).toEqual([]);
		expect(await getSessionRecord(bucket(), sessionId)).toBeNull();
		expect(await bucket().head(`${sessionId}/${fileId}`)).toBeNull();
		expect((await bucket().list({ prefix: 'pending/' })).objects).toEqual([]);
	});

	it('T04: a session the owner cancelled meanwhile is cleaned up exactly once, without errors', async () => {
		const { now, sessionId, fileId } = await overdueSession();
		const cron = racing(sessionId, async () => {
			const { record } = (await getSessionRecord(bucket(), sessionId))!;
			await bucket().put(`sessions/${sessionId}`, JSON.stringify({ ...record, status: 'ABANDONED' }));
		});

		const result = await cleanupExpired(cron, now);

		expect(result.errors).toEqual([]);
		expect(result.abandonedSessions).toBe(1);
		expect(await getSessionRecord(bucket(), sessionId)).toBeNull();
		expect(await bucket().head(`${sessionId}/${fileId}`)).toBeNull();
	});

	it('an ordinary overdue session is still removed, with its files and marker', async () => {
		const { now, sessionId, fileId } = await overdueSession();

		const result = await cleanupExpired(bucket(), now);

		expect(result).toMatchObject({ abandonedSessions: 1, errors: [] });
		expect(await getSessionRecord(bucket(), sessionId)).toBeNull();
		expect(await bucket().head(`${sessionId}/${fileId}`)).toBeNull();
	});
});
