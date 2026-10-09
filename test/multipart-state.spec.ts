import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { getSessionRecord } from '../src/worker/session';
import { cleanupExpired, ABANDONED_SESSION_SECONDS } from '../src/worker/storage';
import { getCurrentTimestamp } from '../src/worker/utils';
import { resetStorage, setupTestEnvironment, createTestSession, testFetch } from './utils/test-setup';

const bucket = () => env.R2_STORAGE;
const TEXT = 'multipart content for state tests';

// The token carries the raw R2 upload id; tests talk to R2 directly with it
function rawUploadId(token: string): string {
	const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
	return JSON.parse(atob(payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), '='))).uploadId;
}

async function startMultipart(sessionId: string, uploadToken: string, size = TEXT.length) {
	const response = await testFetch(`http://example.com/api/upload-sessions/${sessionId}/multipart/create`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${uploadToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ filename: 'big.txt', mimeType: 'text/plain', fileSize: size }),
	});
	expect(response.status).toBe(200);
	return (await response.json()) as { fileId: string; uploadId: string };
}

async function sendPart(sessionId: string, fileId: string, token: string, partNumber = 1) {
	return testFetch(`http://example.com/api/upload-sessions/${sessionId}/multipart/${fileId}/parts/${partNumber}`, {
		method: 'PUT',
		headers: { Authorization: `Bearer ${token}` },
		body: new TextEncoder().encode(TEXT),
	});
}

async function completeMultipart(sessionId: string, fileId: string, token: string, parts: { partNumber: number; etag: string }[]) {
	return testFetch(`http://example.com/api/upload-sessions/${sessionId}/multipart/${fileId}/complete`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ parts }),
	});
}

async function abortMultipart(sessionId: string, fileId: string, token: string) {
	return testFetch(`http://example.com/api/upload-sessions/${sessionId}/multipart/${fileId}/abort`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}` },
	});
}

describe('multipart state and abort', () => {
	beforeEach(async () => {
		await resetStorage();
		await setupTestEnvironment();
	});

	it('refuses parts and completion once the session has been completed', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const { fileId, uploadId } = await startMultipart(sessionId, uploadToken);
		const first = await sendPart(sessionId, fileId, uploadId, 1);
		const { etag } = (await first.json()) as any;

		// Complete the session through a regular upload
		const formData = new FormData();
		formData.append('textItems', JSON.stringify({ content: 'other', filename: 'o.txt' }));
		const upload = await testFetch(`http://example.com/api/upload-sessions/${sessionId}/files`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${uploadToken}` },
			body: formData,
		});
		const otherId = ((await upload.json()) as any).uploadedFiles[0].fileId;
		await testFetch(`http://example.com/api/upload-sessions/${sessionId}/complete`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${uploadToken}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ fileIds: [otherId], validityDays: 7 }),
		});

		const laterPart = await sendPart(sessionId, fileId, uploadId, 2);
		const laterComplete = await completeMultipart(sessionId, fileId, uploadId, [{ partNumber: 1, etag }]);

		expect(laterPart.status).toBe(404);
		expect(laterComplete.status).toBe(404);
		const record = (await getSessionRecord(bucket(), sessionId))!.record;
		expect(record.files.map((f) => f.fileId)).toEqual([otherId]);
	});

	it('aborts an upload: the abort is recorded, later parts and completion are refused, nothing is registered', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const { fileId, uploadId } = await startMultipart(sessionId, uploadToken);
		const part = (await (await sendPart(sessionId, fileId, uploadId)).json()) as any;

		const aborted = await abortMultipart(sessionId, fileId, uploadId);
		expect(aborted.status).toBe(200);

		const partAfter = await sendPart(sessionId, fileId, uploadId, 2);
		expect(partAfter.status).toBe(409);
		expect(((await partAfter.json()) as any).code).toBe('MULTIPART_CLOSED');

		const completeAfter = await completeMultipart(sessionId, fileId, uploadId, [{ partNumber: 1, etag: part.etag }]);
		expect(completeAfter.status).toBe(409);
		expect(await bucket().head(`${sessionId}/${fileId}`)).toBeNull();
		// R2 itself no longer accepts parts for the aborted upload
		await expect(
			bucket()
				.resumeMultipartUpload(`${sessionId}/${fileId}`, rawUploadId(uploadId))
				.uploadPart(3, new Uint8Array([1])),
		).rejects.toThrow();
		const record = (await getSessionRecord(bucket(), sessionId))!.record;
		expect(record.files).toEqual([]);
		expect(record.multipartUploads).toEqual([expect.objectContaining({ fileId, state: 'ABORTED' })]);
	});

	it('treats a repeated abort as success', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const { fileId, uploadId } = await startMultipart(sessionId, uploadToken);
		expect((await abortMultipart(sessionId, fileId, uploadId)).status).toBe(200);
		expect((await abortMultipart(sessionId, fileId, uploadId)).status).toBe(200);
	});

	it('aborts unfinished multipart uploads when the session is completed', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const { fileId, uploadId } = await startMultipart(sessionId, uploadToken);
		await sendPart(sessionId, fileId, uploadId, 1);

		const formData = new FormData();
		formData.append('textItems', JSON.stringify({ content: 'other', filename: 'o.txt' }));
		const upload = await testFetch(`http://example.com/api/upload-sessions/${sessionId}/files`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${uploadToken}` },
			body: formData,
		});
		const otherId = ((await upload.json()) as any).uploadedFiles[0].fileId;
		const completion = await testFetch(`http://example.com/api/upload-sessions/${sessionId}/complete`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${uploadToken}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ fileIds: [otherId], validityDays: 7 }),
		});
		expect(completion.status).toBe(200);

		await expect(
			bucket()
				.resumeMultipartUpload(`${sessionId}/${fileId}`, rawUploadId(uploadId))
				.uploadPart(2, new Uint8Array([1])),
		).rejects.toThrow();
	});

	it('control: an active multipart upload still accepts parts (so the abort tests are meaningful)', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const { fileId, uploadId } = await startMultipart(sessionId, uploadToken);

		const part = await bucket()
			.resumeMultipartUpload(`${sessionId}/${fileId}`, rawUploadId(uploadId))
			.uploadPart(2, new Uint8Array([1]));
		expect(part.partNumber).toBe(2);
	});

	it('aborts the multipart uploads of an abandoned session during cleanup', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const { fileId, uploadId } = await startMultipart(sessionId, uploadToken);
		await sendPart(sessionId, fileId, uploadId, 1);

		await cleanupExpired(bucket(), getCurrentTimestamp() + ABANDONED_SESSION_SECONDS + 60);

		await expect(
			bucket()
				.resumeMultipartUpload(`${sessionId}/${fileId}`, rawUploadId(uploadId))
				.uploadPart(2, new Uint8Array([1])),
		).rejects.toThrow();
		expect(await getSessionRecord(bucket(), sessionId)).toBeNull();
	});

	it('completes a multipart file and registers it once', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const { fileId, uploadId } = await startMultipart(sessionId, uploadToken);
		const { etag } = (await (await sendPart(sessionId, fileId, uploadId)).json()) as any;

		const first = await completeMultipart(sessionId, fileId, uploadId, [{ partNumber: 1, etag }]);
		expect(first.status).toBe(200);
		const second = await completeMultipart(sessionId, fileId, uploadId, [{ partNumber: 1, etag }]);
		expect(second.status).toBe(409);

		const record = (await getSessionRecord(bucket(), sessionId))!.record;
		expect(record.files.map((f) => f.fileId)).toEqual([fileId]);
		expect(record.multipartUploads).toEqual([expect.objectContaining({ fileId, state: 'COMPLETED' })]);
	});

	it('rejects malformed completion part lists', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const { fileId, uploadId } = await startMultipart(sessionId, uploadToken);
		const { etag } = (await (await sendPart(sessionId, fileId, uploadId)).json()) as any;

		const duplicate = await completeMultipart(sessionId, fileId, uploadId, [
			{ partNumber: 1, etag },
			{ partNumber: 1, etag },
		]);
		const badNumber = await completeMultipart(sessionId, fileId, uploadId, [{ partNumber: 0, etag }]);
		const emptyEtag = await completeMultipart(sessionId, fileId, uploadId, [{ partNumber: 1, etag: '' }]);
		const notArray = await testFetch(`http://example.com/api/upload-sessions/${sessionId}/multipart/${fileId}/complete`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${uploadId}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ parts: 'nope' }),
		});

		for (const response of [duplicate, badNumber, emptyEtag, notArray]) {
			expect(response.status).toBe(400);
			await response.text();
		}
	});

	it('refuses a token whose upload id does not match the recorded upload', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const { fileId } = await startMultipart(sessionId, uploadToken);
		const other = await startMultipart(sessionId, uploadToken);

		const response = await sendPart(sessionId, fileId, other.uploadId, 1);
		expect(response.status).toBe(403);
		await response.text();
	});
});
