import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
	acquireLease,
	beginFinalize,
	createSessionRecord,
	getSessionRecord,
	releaseLease,
	SessionError,
	transitionSession,
} from '../src/worker/session';
import { getCurrentTimestamp } from '../src/worker/utils';
import { resetStorage, setupTestEnvironment, createTestSession, testFetch } from './utils/test-setup';

const bucket = () => env.R2_STORAGE;
const LEASE_SECONDS = 15 * 60;

async function errorCodeOf(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		return error instanceof SessionError ? error.code : `unexpected: ${error}`;
	}
	return 'no error';
}

async function newOpenSession(): Promise<string> {
	const sessionId = crypto.randomUUID();
	await createSessionRecord(bucket(), { sessionId, createdAt: getCurrentTimestamp() });
	return sessionId;
}

function uploadText(sessionId: string, uploadToken: string, content: string, filename = 'a.txt') {
	const formData = new FormData();
	formData.append('textItems', JSON.stringify({ content, filename }));
	return testFetch(`http://example.com/api/chest/${sessionId}/upload`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${uploadToken}` },
		body: formData,
	});
}

function complete(sessionId: string, uploadToken: string, fileIds: string[]) {
	return testFetch(`http://example.com/api/chest/${sessionId}/complete`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${uploadToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ fileIds, validityDays: 7 }),
	});
}

describe('write leases and the completion barrier', () => {
	beforeEach(async () => {
		await resetStorage();
		await setupTestEnvironment();
	});

	it('blocks completion while a lease is held, and allows it once the lease is released', async () => {
		const sessionId = await newOpenSession();
		const now = getCurrentTimestamp();
		await acquireLease(bucket(), sessionId, { id: 'lease-1', expiresAt: now + LEASE_SECONDS }, now);

		expect(await errorCodeOf(beginFinalize(bucket(), sessionId, 'fp', now))).toBe('LEASE_ACTIVE');
		expect((await getSessionRecord(bucket(), sessionId))?.record.status).toBe('OPEN');

		await releaseLease(bucket(), sessionId, 'lease-1', [], now);
		const finalizing = await beginFinalize(bucket(), sessionId, 'fp', now);
		expect(finalizing.status).toBe('FINALIZING');
	});

	it('drops an expired lease at completion, and its late release cannot register a file', async () => {
		const sessionId = await newOpenSession();
		const now = getCurrentTimestamp();
		await acquireLease(bucket(), sessionId, { id: 'slow', expiresAt: now - 1 }, now - LEASE_SECONDS - 10);

		await beginFinalize(bucket(), sessionId, 'fp', now);
		const late = {
			fileId: crypto.randomUUID(),
			filename: 'late.txt',
			size: 1,
			mimeType: 'text/plain',
			isText: false,
			fileExtension: 'txt',
		};
		expect(await errorCodeOf(releaseLease(bucket(), sessionId, 'slow', [late], now))).toBe('LEASE_LOST');
		expect((await getSessionRecord(bucket(), sessionId))?.record.files).toEqual([]);
	});

	it('refuses new leases once the session is no longer OPEN', async () => {
		const sessionId = await newOpenSession();
		const now = getCurrentTimestamp();
		await beginFinalize(bucket(), sessionId, 'fp', now);

		expect(await errorCodeOf(acquireLease(bucket(), sessionId, { id: 'x', expiresAt: now + 60 }, now))).toBe('NOT_OPEN');
	});

	it('registers a verified file once and dedupes repeated registration', async () => {
		const sessionId = await newOpenSession();
		const now = getCurrentTimestamp();
		const file = { fileId: crypto.randomUUID(), filename: 'a.txt', size: 3, mimeType: 'text/plain', isText: false, fileExtension: 'txt' };
		await acquireLease(bucket(), sessionId, { id: 'w', expiresAt: now + 60 }, now);
		await releaseLease(bucket(), sessionId, 'w', [file], now);

		await acquireLease(bucket(), sessionId, { id: 'w2', expiresAt: now + 60 }, now);
		const record = await releaseLease(bucket(), sessionId, 'w2', [file], now);
		expect(record.files).toHaveLength(1);
	});

	it('returns 409 and keeps the session open while an upload is in progress', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const first = await uploadText(sessionId, uploadToken, 'first');
		const fileId = ((await first.json()) as any).uploadedFiles[0].fileId;

		// Simulate a write that still holds its lease
		await acquireLease(bucket(), sessionId, { id: 'stuck', expiresAt: getCurrentTimestamp() + LEASE_SECONDS });
		const response = await complete(sessionId, uploadToken, [fileId]);
		expect(response.status).toBe(409);
		expect(((await response.json()) as any).code).toBe('UPLOAD_IN_PROGRESS');
		expect((await getSessionRecord(bucket(), sessionId))?.record.status).toBe('OPEN');
	});

	it('only completes files that were registered by finished uploads', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const response = await complete(sessionId, uploadToken, [crypto.randomUUID()]);

		expect(response.status).toBe(400);
		expect(((await response.json()) as any).code).toBe('FILE_NOT_IN_SESSION');
		// The failed completion rolls back, so the session can still take uploads
		expect((await getSessionRecord(bucket(), sessionId))?.record.status).toBe('OPEN');
		expect((await uploadText(sessionId, uploadToken, 'later')).status).toBe(200);
	});

	it('never includes a file in the chest that was not finished when completion ran', async () => {
		for (let round = 0; round < 5; round++) {
			const { sessionId, uploadToken } = await createTestSession();
			const done = await uploadText(sessionId, uploadToken, 'done');
			const doneId = ((await done.json()) as any).uploadedFiles[0].fileId;

			// A second upload and the completion race each other
			const [late, completion] = await Promise.all([
				uploadText(sessionId, uploadToken, 'late', 'late.txt'),
				complete(sessionId, uploadToken, [doneId]),
			]);

			expect([200, 409]).toContain(late.status);
			// Either the late upload finished first (completion waits and refuses with 409), or completion
			// won and the late upload is refused. Both are fine; a late file must never leak into the chest.
			expect([200, 409]).toContain(completion.status);
			if (completion.status === 200) {
				const { retrievalCode } = (await completion.json()) as any;
				const manifest = (await (await bucket().get(`codes/${retrievalCode}`))!.json()) as any;
				expect(manifest.files.map((f: any) => f.fileId)).toEqual([doneId]);
				expect((await uploadText(sessionId, uploadToken, 'after')).status).toBe(404);
			} else {
				expect((await getSessionRecord(bucket(), sessionId))?.record.status).toBe('OPEN');
				expect((await getSessionRecord(bucket(), sessionId))?.record.retrievalCode).toBeNull();
			}
		}
	});

	it('rejects a multipart file whose uploaded size differs from the declared size, and leaves no object behind', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const create = await testFetch(`http://example.com/api/chest/${sessionId}/multipart/create`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${uploadToken}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ filename: 'short.txt', mimeType: 'text/plain', fileSize: 100 }),
		});
		const { fileId, uploadId } = (await create.json()) as any;

		const part = await testFetch(`http://example.com/api/chest/${sessionId}/multipart/${fileId}/part/1`, {
			method: 'PUT',
			headers: { Authorization: `Bearer ${uploadId}` },
			body: new TextEncoder().encode('only ten!!'),
		});
		const { etag } = (await part.json()) as any;

		const response = await testFetch(`http://example.com/api/chest/${sessionId}/multipart/${fileId}/complete`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${uploadId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ parts: [{ partNumber: 1, etag }] }),
		});

		expect(response.status).toBe(400);
		expect(((await response.json()) as any).code).toBe('SIZE_MISMATCH');
		expect(await bucket().head(`${sessionId}/${fileId}`)).toBeNull();
		expect((await getSessionRecord(bucket(), sessionId))?.record.status).toBe('OPEN');
	});

	it('keeps completing transitions reachable through the state machine', async () => {
		const sessionId = await newOpenSession();
		await transitionSession(bucket(), sessionId, 'FINALIZING');
		expect(await errorCodeOf(transitionSession(bucket(), sessionId, 'FINALIZING'))).toBe('INVALID_TRANSITION');
	});
});
