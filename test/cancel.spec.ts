import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { getSessionRecord } from '../src/worker/session';
import { cleanupExpired, ABANDONED_SESSION_SECONDS } from '../src/worker/storage';
import { getCurrentTimestamp } from '../src/worker/utils';
import { resetStorage, setupTestEnvironment, createTestSession, testFetch } from './utils/test-setup';

const bucket = () => env.R2_STORAGE;

function rawUploadId(token: string): string {
	const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
	return JSON.parse(atob(payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), '='))).uploadId;
}

async function cancel(sessionId: string, token: string) {
	return testFetch(`http://example.com/api/chest/${sessionId}/cancel`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}` },
	});
}

describe('cancelling an upload session', () => {
	beforeEach(async () => {
		await resetStorage();
		await setupTestEnvironment();
	});

	it('refuses further uploads and completion, and marks the session abandoned', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const cancelled = await cancel(sessionId, uploadToken);
		expect(cancelled.status).toBe(200);

		const formData = new FormData();
		formData.append('textItems', JSON.stringify({ content: 'late', filename: 'late.txt' }));
		const upload = await testFetch(`http://example.com/api/chest/${sessionId}/upload`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${uploadToken}` },
			body: formData,
		});
		expect(upload.status).toBe(404);
		await upload.text();
		expect((await getSessionRecord(bucket(), sessionId))?.record.status).toBe('ABANDONED');
	});

	it('aborts the unfinished multipart uploads of the session', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const create = await testFetch(`http://example.com/api/chest/${sessionId}/multipart/create`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${uploadToken}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ filename: 'cancel.bin', mimeType: 'application/octet-stream', fileSize: 10 }),
		});
		const { fileId, uploadId } = (await create.json()) as any;

		expect((await cancel(sessionId, uploadToken)).status).toBe(200);

		await expect(
			bucket()
				.resumeMultipartUpload(`${sessionId}/${fileId}`, rawUploadId(uploadId))
				.uploadPart(1, new Uint8Array([1])),
		).rejects.toThrow();
		const part = await testFetch(`http://example.com/api/chest/${sessionId}/multipart/${fileId}/part/1`, {
			method: 'PUT',
			headers: { Authorization: `Bearer ${uploadId}` },
			body: new Uint8Array([1]),
		});
		expect(part.status).toBe(404);
		await part.text();
	});

	it('treats a repeated cancel as success', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		expect((await cancel(sessionId, uploadToken)).status).toBe(200);
		expect((await cancel(sessionId, uploadToken)).status).toBe(200);
	});

	it('requires the session upload token', async () => {
		const { sessionId } = await createTestSession();
		const other = await createTestSession();
		const response = await cancel(sessionId, other.uploadToken);
		expect(response.status).toBe(400);
		await response.text();
		expect((await getSessionRecord(bucket(), sessionId))?.record.status).toBe('OPEN');
	});

	it("removes a cancelled session's content in the next cleanup", async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const formData = new FormData();
		formData.append('textItems', JSON.stringify({ content: 'drop', filename: 'drop.txt' }));
		await testFetch(`http://example.com/api/chest/${sessionId}/upload`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${uploadToken}` },
			body: formData,
		});
		await cancel(sessionId, uploadToken);

		await cleanupExpired(bucket(), getCurrentTimestamp() + ABANDONED_SESSION_SECONDS + 60);
		expect(await getSessionRecord(bucket(), sessionId)).toBeNull();
		expect((await bucket().list({ prefix: `${sessionId}/` })).objects).toEqual([]);
	});
});
