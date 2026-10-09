import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { createSessionRecord, getSessionRecord, transitionSession, SessionError } from '../src/worker/session';
import { openSession, isSessionOpen, cleanupExpired, ABANDONED_SESSION_SECONDS } from '../src/worker/storage';
import { getCurrentTimestamp } from '../src/worker/utils';
import { resetStorage, setupTestEnvironment, createTestSession, testFetch } from './utils/test-setup';

const bucket = () => env.R2_STORAGE;

async function newSessionId(): Promise<string> {
	const sessionId = crypto.randomUUID();
	await createSessionRecord(bucket(), { sessionId, createdAt: getCurrentTimestamp() });
	return sessionId;
}

async function errorCodeOf(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return error instanceof SessionError ? error.code : `unexpected: ${error}`;
	}
	return 'no error';
}

describe('session record and CAS transitions', () => {
	beforeEach(async () => {
		await resetStorage();
		await setupTestEnvironment();
	});

	it('creates an OPEN record that can be read back', async () => {
		const sessionId = await newSessionId();
		const stored = await getSessionRecord(bucket(), sessionId);
		expect(stored?.record).toMatchObject({ version: 1, sessionId, status: 'OPEN', retrievalCode: null, expiresAt: null });
		expect(stored?.etag).toBeTruthy();
	});

	it('refuses to create a second record for the same session', async () => {
		const sessionId = await newSessionId();
		await expect(createSessionRecord(bucket(), { sessionId, createdAt: getCurrentTimestamp() })).rejects.toMatchObject({
			code: 'ALREADY_EXISTS',
		});
	});

	it('lets exactly one of two concurrent OPEN -> FINALIZING transitions succeed', async () => {
		const sessionId = await newSessionId();

		const results = await Promise.allSettled([
			transitionSession(bucket(), sessionId, 'FINALIZING'),
			transitionSession(bucket(), sessionId, 'FINALIZING'),
		]);

		const fulfilled = results.filter((r) => r.status === 'fulfilled');
		const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect(rejected[0].reason).toBeInstanceOf(SessionError);
		expect((await getSessionRecord(bucket(), sessionId))?.record.status).toBe('FINALIZING');
	});

	it('rejects transitions that the state machine does not allow', async () => {
		const sessionId = await newSessionId();
		await transitionSession(bucket(), sessionId, 'FINALIZING');
		await transitionSession(bucket(), sessionId, 'COMPLETED', { retrievalCode: 'ABC123', expiresAt: null, fileIds: [] });

		expect(await errorCodeOf(transitionSession(bucket(), sessionId, 'OPEN'))).toBe('INVALID_TRANSITION');
		expect(await errorCodeOf(transitionSession(bucket(), sessionId, 'ABANDONED'))).toBe('INVALID_TRANSITION');
		expect((await getSessionRecord(bucket(), sessionId))?.record.status).toBe('COMPLETED');
	});

	it('keeps the completed result fields once they are set', async () => {
		const sessionId = await newSessionId();
		await transitionSession(bucket(), sessionId, 'FINALIZING');
		const record = await transitionSession(bucket(), sessionId, 'COMPLETED', {
			retrievalCode: 'ABC123',
			expiresAt: 2000000000,
			fileIds: ['11111111-1111-4111-8111-111111111111'],
		});
		expect(record).toMatchObject({ status: 'COMPLETED', retrievalCode: 'ABC123', expiresAt: 2000000000 });
		expect(record.fileIds).toEqual(['11111111-1111-4111-8111-111111111111']);
	});

	it('fails safe on a record it cannot validate instead of treating it as OPEN', async () => {
		const sessionId = crypto.randomUUID();
		await bucket().put(`sessions/${sessionId}`, JSON.stringify({ sessionId }));

		expect(await errorCodeOf(getSessionRecord(bucket(), sessionId))).toBe('CORRUPT_RECORD');
		expect(await isSessionOpen(bucket(), sessionId)).toBe(false);
	});

	it('keeps one authoritative record per session and treats the pending marker only as an index', async () => {
		const sessionId = crypto.randomUUID();
		await openSession(bucket(), sessionId, getCurrentTimestamp());

		expect(await isSessionOpen(bucket(), sessionId)).toBe(true);
		const records = await bucket().list({ prefix: `sessions/${sessionId}` });
		expect(records.objects.map((o) => o.key)).toEqual([`sessions/${sessionId}`]);
	});

	it('does not delete a session that is no longer OPEN just because its pending marker is missing', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const formData = new FormData();
		formData.append('textItems', JSON.stringify({ content: 'keep me', filename: 'keep.txt' }));
		const upload = await testFetch(`http://example.com/api/chest/${sessionId}/upload`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${uploadToken}` },
			body: formData,
		});
		const fileId = ((await upload.json()) as any).uploadedFiles[0].fileId;
		const complete = await testFetch(`http://example.com/api/chest/${sessionId}/complete`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${uploadToken}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ fileIds: [fileId], validityDays: 7 }),
		});
		expect(complete.status).toBe(200);
		// Simulate losing the pending index entry for this session
		const markers = await bucket().list({ prefix: `pending/` });
		await bucket().delete(markers.objects.map((o) => o.key));

		await cleanupExpired(bucket(), getCurrentTimestamp() + ABANDONED_SESSION_SECONDS + 3600);
		expect(await bucket().head(`${sessionId}/${fileId}`)).not.toBeNull();
	});
});
