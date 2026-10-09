import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { acquireLease, getSessionRecord, releaseLease } from '../src/worker/session';
import { getCurrentTimestamp } from '../src/worker/utils';
import { LIMITS } from '../src/worker/limits';
import { resetStorage, setupTestEnvironment, createTestSession, testFetch } from './utils/test-setup';

const bucket = () => env.R2_STORAGE;

function formWith(parts: { files?: File[]; texts?: { content: string; filename?: string }[] }): FormData {
	const formData = new FormData();
	for (const file of parts.files ?? []) formData.append('files', file);
	for (const text of parts.texts ?? []) formData.append('textItems', JSON.stringify(text));
	return formData;
}

async function upload(sessionId: string, uploadToken: string, body: FormData | string, headers: Record<string, string> = {}) {
	return testFetch(`http://example.com/api/upload-sessions/${sessionId}/files`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${uploadToken}`, ...headers },
		body,
	});
}

async function errorCode(response: Response): Promise<string> {
	return ((await response.json()) as any).code;
}

describe('upload limits and quotas', () => {
	beforeEach(async () => {
		await resetStorage();
		await setupTestEnvironment();
	});

	it('rejects a request larger than the body limit before reading it', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const response = await upload(sessionId, uploadToken, 'x', { 'Content-Length': String(LIMITS.maxUploadRequestBytes + 1) });

		expect(response.status).toBe(413);
		expect(await errorCode(response)).toBe('PAYLOAD_TOO_LARGE');
	});

	it('rejects a regular file above the small-file limit', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const big = new File([new Uint8Array(LIMITS.maxSmallFileBytes + 1)], 'big.bin', { type: 'application/octet-stream' });
		const response = await upload(sessionId, uploadToken, formWith({ files: [big] }));

		expect(response.status).toBe(413);
		expect(await errorCode(response)).toBe('FILE_TOO_LARGE');
		expect((await getSessionRecord(bucket(), sessionId))?.record.files).toEqual([]);
	});

	it('rejects text over the byte limit (UTF-8 bytes, not characters)', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		// 3 bytes per character: this is under the character count but over the byte limit
		const content = '世'.repeat(Math.floor(LIMITS.maxTextBytes / 3) + 1);
		const response = await upload(sessionId, uploadToken, formWith({ texts: [{ content, filename: 'a.txt' }] }));

		expect(response.status).toBe(413);
		expect(await errorCode(response)).toBe('TEXT_TOO_LARGE');
	});

	it('rejects a filename longer than the byte limit', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const name = `${'a'.repeat(LIMITS.maxFilenameBytes)}.txt`;
		const response = await upload(sessionId, uploadToken, formWith({ files: [new File(['x'], name)] }));

		expect(response.status).toBe(400);
		expect(await errorCode(response)).toBe('FILENAME_TOO_LONG');
	});

	it('limits the number of files in a session', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const files = Array.from({ length: LIMITS.maxFilesPerSession + 1 }, (_, i) => new File([`${i}`], `f${i}.txt`));
		const response = await upload(sessionId, uploadToken, formWith({ files }));

		expect(response.status).toBe(413);
		expect(await errorCode(response)).toBe('TOO_MANY_FILES');
	});

	it('does not let two concurrent writes both take the last free file slot', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		// Fill all but one slot directly, then race two single-file uploads for the last one
		const now = getCurrentTimestamp();
		const filler = Array.from({ length: LIMITS.maxFilesPerSession - 1 }, (_, i) => ({
			fileId: crypto.randomUUID(),
			filename: `fill${i}.txt`,
			size: 1,
			mimeType: 'text/plain',
			isText: false,
			fileExtension: 'txt',
		}));
		await acquireLease(bucket(), sessionId, { id: 'fill', expiresAt: now + 60, files: 0, bytes: 0 }, now);
		await releaseLease(bucket(), sessionId, 'fill', filler, now);

		const [a, b] = await Promise.all([
			upload(sessionId, uploadToken, formWith({ files: [new File(['a'], 'a.txt')] })),
			upload(sessionId, uploadToken, formWith({ files: [new File(['b'], 'b.txt')] })),
		]);

		expect([a.status, b.status].sort()).toEqual([200, 413]);
		expect((await getSessionRecord(bucket(), sessionId))?.record.files).toHaveLength(LIMITS.maxFilesPerSession);
	});

	it('refuses to complete a session whose files are all empty', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const uploaded = (await (await upload(sessionId, uploadToken, formWith({ files: [new File([], 'empty.txt')] }))).json()) as any;
		const response = await testFetch(`http://example.com/api/upload-sessions/${sessionId}/complete`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${uploadToken}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ fileIds: [uploaded.uploadedFiles[0].fileId], validityDays: 7 }),
		});

		expect(response.status).toBe(400);
		expect(await errorCode(response)).toBe('EMPTY_CHEST');
	});

	it('still accepts an empty file alongside content', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const uploaded = (await (
			await upload(sessionId, uploadToken, formWith({ files: [new File([], 'empty.txt'), new File(['x'], 'x.txt')] }))
		).json()) as any;
		const response = await testFetch(`http://example.com/api/upload-sessions/${sessionId}/complete`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${uploadToken}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ fileIds: uploaded.uploadedFiles.map((f: any) => f.fileId), validityDays: 7 }),
		});

		expect(response.status).toBe(200);
	});

	it('rejects a part larger than the part limit before reading it', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const start = await testFetch(`http://example.com/api/upload-sessions/${sessionId}/multipart/create`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${uploadToken}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ filename: 'big.bin', mimeType: 'application/octet-stream', fileSize: 1000 }),
		});
		const { fileId, uploadId } = (await start.json()) as any;

		const response = await testFetch(`http://example.com/api/upload-sessions/${sessionId}/multipart/${fileId}/parts/1`, {
			method: 'PUT',
			headers: { Authorization: `Bearer ${uploadId}`, 'Content-Length': String(LIMITS.maxPartBytes + 1) },
			body: 'x',
		});

		expect(response.status).toBe(413);
		expect(await errorCode(response)).toBe('PAYLOAD_TOO_LARGE');
	});

	it('does not accept a multipart upload that would exceed the session byte budget', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		// 6 GiB are already stored, so the largest multipart file no longer fits in the session budget
		const now = getCurrentTimestamp();
		await acquireLease(bucket(), sessionId, { id: 'one-byte', expiresAt: now + 60, files: 0, bytes: 0 }, now);
		await releaseLease(
			bucket(),
			sessionId,
			'one-byte',
			[{ fileId: crypto.randomUUID(), filename: 'one.txt', size: 6 * 1024 ** 3, mimeType: 'text/plain', isText: false, fileExtension: 'txt' }],
			now,
		);

		const response = await testFetch(`http://example.com/api/upload-sessions/${sessionId}/multipart/create`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${uploadToken}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ filename: 'huge.bin', mimeType: 'application/octet-stream', fileSize: LIMITS.maxMultipartFileBytes }),
		});

		expect(response.status).toBe(413);
		expect(await errorCode(response)).toBe('SESSION_QUOTA_EXCEEDED');
	});
});
