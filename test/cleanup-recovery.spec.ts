import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import worker from '../src/worker/index';
import { beginFinalize, createSessionRecord, getSessionRecord } from '../src/worker/session';
import { cleanupExpired } from '../src/worker/storage';
import { getCurrentTimestamp } from '../src/worker/utils';
import { resetStorage, setupTestEnvironment, createTestSession, testFetch } from './utils/test-setup';

const bucket = () => env.R2_STORAGE;
const HOUR = 3600;

async function listKeys(prefix: string): Promise<string[]> {
	const page = await bucket().list({ prefix });
	return page.objects.map((o) => o.key);
}

// A completed chest written directly in R2 (cheap enough for 200+ fixtures)
async function syntheticChest(code: string, expiresAt: number | null, now: number) {
	const sessionId = crypto.randomUUID();
	const fileId = crypto.randomUUID();
	const file = { fileId, filename: `${code}.txt`, size: 4, mimeType: 'text/plain', isText: true, fileExtension: 'txt' };
	await bucket().put(`${sessionId}/${fileId}`, 'data');
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
			validityDays: expiresAt === null ? -1 : 7,
			expiresAt,
			fileIds: [fileId],
		}),
	);
	await bucket().put(`codes/${code}`, JSON.stringify({ version: 1, sessionId, createdAt: now, expiresAt, files: [file] }));
	if (expiresAt !== null) {
		await bucket().put(`expiry/${String(expiresAt).padStart(10, '0')}/${code}`, '');
	}
	return { sessionId, fileId };
}

describe('cleanup recovery', () => {
	beforeEach(async () => {
		await resetStorage();
		await setupTestEnvironment();
	});

	it('keeps a completed chest whose pending index entry was left behind', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const formData = new FormData();
		formData.append('textItems', JSON.stringify({ content: 'keep me', filename: 'keep.txt' }));
		const upload = await testFetch(`http://example.com/api/chest/${sessionId}/upload`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${uploadToken}` },
			body: formData,
		});
		const fileId = ((await upload.json()) as any).uploadedFiles[0].fileId;
		const completion = (await (
			await testFetch(`http://example.com/api/chest/${sessionId}/complete`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${uploadToken}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ fileIds: [fileId], validityDays: 7 }),
			})
		).json()) as any;
		const createdAt = (await getSessionRecord(bucket(), sessionId))!.record.createdAt;
		await bucket().put(`pending/${String(createdAt).padStart(10, '0')}/${sessionId}`, '');

		await cleanupExpired(bucket(), getCurrentTimestamp() + 49 * HOUR);

		const retrieve = await testFetch(`http://example.com/api/retrieve/${completion.retrievalCode}`);
		expect(retrieve.status).toBe(200);
		const { chestToken } = (await retrieve.json()) as any;
		const download = await testFetch(`http://example.com/api/download/${fileId}`, { headers: { Authorization: `Bearer ${chestToken}` } });
		expect(await download.text()).toBe('keep me');
	});

	it('removes an expired chest completely: files, manifest, expiry index and session record', async () => {
		const now = getCurrentTimestamp();
		const { sessionId } = await syntheticChest('EXPIR1', now - 10, now);

		const result = await cleanupExpired(bucket(), now);

		expect(result.expiredChests).toBe(1);
		expect(result.errors).toEqual([]);
		expect(await listKeys(`${sessionId}/`)).toEqual([]);
		expect(await listKeys('codes/EXPIR1')).toEqual([]);
		expect(await listKeys('expiry/')).toEqual([]);
		expect(await getSessionRecord(bucket(), sessionId)).toBeNull();
	});

	it('clears a backlog of more than 200 expired chests over consecutive runs', async () => {
		const now = getCurrentTimestamp();
		for (let i = 0; i < 201; i++) {
			await syntheticChest(`B${String(i).padStart(5, '0')}`, now - 1000 + i, now);
		}

		const first = await cleanupExpired(bucket(), now);
		expect(first.expiredChests).toBe(200);
		expect(first.backlog.expired).toBe(true);

		const second = await cleanupExpired(bucket(), now);
		expect(second.expiredChests).toBe(1);
		expect(second.backlog.expired).toBe(false);
		expect(await listKeys('codes/')).toEqual([]);
	}, 60_000);

	it('reports a failed deletion and finishes it on the next run, without touching permanent chests', async () => {
		const now = getCurrentTimestamp();
		const expired = await syntheticChest('RETRY1', now - 10, now);
		const permanent = await syntheticChest('PERM01', null, now);

		let failed = false;
		const flaky = new Proxy(bucket(), {
			get(target, property) {
				if (property === 'delete') {
					return (keys: string | string[]) => {
						const list = Array.isArray(keys) ? keys : [keys];
						if (!failed && list.some((key) => key.startsWith(`${expired.sessionId}/`))) {
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
		expect(await getSessionRecord(bucket(), expired.sessionId)).not.toBeNull();

		const second = await cleanupExpired(bucket(), now);
		expect(second.errors).toEqual([]);
		expect(await listKeys(`${expired.sessionId}/`)).toEqual([]);
		expect(await listKeys(`${permanent.sessionId}/`)).toHaveLength(1);
		expect(await listKeys('codes/PERM01')).toEqual(['codes/PERM01']);
	});

	it('does not delete a session whose code was replaced: an old expiry entry only removes its own claim', async () => {
		const now = getCurrentTimestamp();
		// The session was finalized with OLD, then rolled back and completed again with NEW
		const { sessionId, fileId } = await syntheticChest('NEW001', null, now);
		await bucket().put('codes/OLD001', JSON.stringify({ version: 1, sessionId, createdAt: now, expiresAt: now - 10, files: [] }));
		await bucket().put(`expiry/${String(now - 10).padStart(10, '0')}/OLD001`, '');

		const result = await cleanupExpired(bucket(), now);

		expect(result.errors).toEqual([]);
		expect(await listKeys('codes/OLD001')).toEqual([]);
		expect(await listKeys('expiry/')).toEqual([]);
		expect(await bucket().head(`${sessionId}/${fileId}`)).not.toBeNull();
		expect((await getSessionRecord(bucket(), sessionId))?.record.retrievalCode).toBe('NEW001');
	});

	it('rolls back a completion stuck in FINALIZING, so the client can retry', async () => {
		const now = getCurrentTimestamp();
		const sessionId = crypto.randomUUID();
		const fileId = crypto.randomUUID();
		await createSessionRecord(bucket(), { sessionId, createdAt: now - 3 * HOUR });
		await bucket().put(`${sessionId}/${fileId}`, 'x');
		await bucket().put(`pending/${String(now - 3 * HOUR).padStart(10, '0')}/${sessionId}`, '');
		// Register the file the way a finished upload would, so the completion had something to finish
		const raw = (await getSessionRecord(bucket(), sessionId))!.record;
		await bucket().put(
			`sessions/${sessionId}`,
			JSON.stringify({
				...raw,
				files: [{ fileId, filename: 'x.txt', size: 1, mimeType: 'text/plain', isText: true, fileExtension: 'txt' }],
			}),
		);
		const startedAt = now - 2 * HOUR;
		await beginFinalize(bucket(), sessionId, `${fileId}|7`, startedAt);
		await bucket().put(`finalizing/${String(startedAt).padStart(10, '0')}/${sessionId}`, '');

		const result = await cleanupExpired(bucket(), now);

		expect(result.rolledBackFinalizations).toBe(1);
		expect((await getSessionRecord(bucket(), sessionId))?.record.status).toBe('OPEN');
		expect(await bucket().head(`${sessionId}/${fileId}`)).not.toBeNull();
		expect(await listKeys('finalizing/')).toEqual([]);
	});

	it('removes orphaned file objects whose session record no longer exists, after the grace period', async () => {
		const now = getCurrentTimestamp();
		const orphanSession = crypto.randomUUID();
		await bucket().put(`${orphanSession}/${crypto.randomUUID()}`, 'lost');
		const live = await syntheticChest('LIVE01', null, now);

		const result = await cleanupExpired(bucket(), now + 49 * HOUR);

		expect(result.orphanObjects).toBe(1);
		expect(await listKeys(`${orphanSession}/`)).toEqual([]);
		expect(await listKeys(`${live.sessionId}/`)).toHaveLength(1);
	});

	it('exposes the same cleanup outcome to the scheduled handler', async () => {
		const ctx = { waitUntil: () => undefined, passThroughOnException: () => undefined } as unknown as ExecutionContext;
		await expect(worker.scheduled({} as ScheduledController, env, ctx)).resolves.toBeUndefined();
	});
});
