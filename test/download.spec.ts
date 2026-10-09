import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { resetStorage, setupTestEnvironment, createTestSession, testFetch, postRetrieve, fetchDownload } from './utils/test-setup';

describe('GET /api/download/:fileId - Download File', () => {
	let chestToken: string;
	let fileId: string;
	let textFileId: string;

	beforeAll(async () => {
		await resetStorage();
	});

	beforeEach(async () => {
		await setupTestEnvironment();

		const session = await createTestSession();
		const uploadToken = session.uploadToken;

		const formData = new FormData();
		formData.append('files', new File(['download test content'], 'download-test.txt', { type: 'text/plain' }));
		formData.append('textItems', JSON.stringify({ content: 'Text download content', filename: 'text-download.txt' }));

		const uploadData = (await (
			await testFetch(`http://example.com/api/upload-sessions/${session.sessionId}/files`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${uploadToken}` },
				body: formData,
			})
		).json()) as any;
		const fileIds = uploadData.uploadedFiles.map((f: any) => f.fileId);
		fileId = uploadData.uploadedFiles.find((f: any) => !f.isText).fileId;
		textFileId = uploadData.uploadedFiles.find((f: any) => f.isText).fileId;

		const completeData = (await (
			await testFetch(`http://example.com/api/upload-sessions/${session.sessionId}/complete`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${uploadToken}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ fileIds, validityDays: 7 }),
			})
		).json()) as any;

		chestToken = ((await (await postRetrieve(completeData.retrievalCode)).json()) as any).chestToken;
	});

	it('downloads the file with its content and headers, through an authorized download', async () => {
		const response = await fetchDownload(chestToken, fileId);

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toBe('text/plain');
		expect(response.headers.get('Content-Disposition')).toContain('filename="download-test.txt"');
		expect(await response.text()).toBe('download test content');
	});

	it('downloads text items correctly', async () => {
		const response = await fetchDownload(chestToken, textFileId);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('Text download content');
	});

	it('ignores a filename supplied in the query string', async () => {
		const response = await fetchDownload(chestToken, fileId);
		const again = await testFetch(`http://example.com/api/download/${fileId}?filename=other.exe`, {
			headers: { Cookie: (response.headers.get('Set-Cookie') ?? '').split(';')[0] },
		});
		await response.text();

		expect(again.status).toBe(401);
		await again.text();
	});

	it('refuses the retired ?token= query form', async () => {
		const response = await testFetch(`http://example.com/api/download/${fileId}?token=${chestToken}`);

		expect(response.status).toBe(401);
		expect(((await response.json()) as any).code).toBe('AUTH_REQUIRED');
	});

	it('refuses a download without any authorization', async () => {
		const response = await testFetch(`http://example.com/api/download/${fileId}`);

		expect(response.status).toBe(401);
		await response.text();
	});

	it('returns 404 for a file id that is not in the chest', async () => {
		const response = await fetchDownload(chestToken, '00000000-0000-4000-8000-000000000000');

		expect(response.status).toBe(404);
		await response.text();
	});

	it('quotes unusual characters in the name sent back in Content-Disposition', async () => {
		const session = await createTestSession();
		const formData = new FormData();
		formData.append('files', new File(['x'], 'bad "name" 報告.txt', { type: 'text/plain' }));
		const uploaded = (await (
			await testFetch(`http://example.com/api/upload-sessions/${session.sessionId}/files`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${session.uploadToken}` },
				body: formData,
			})
		).json()) as any;
		const completed = (await (
			await testFetch(`http://example.com/api/upload-sessions/${session.sessionId}/complete`, {
				method: 'POST',
				headers: { Authorization: `Bearer ${session.uploadToken}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ fileIds: [uploaded.uploadedFiles[0].fileId], validityDays: 7 }),
			})
		).json()) as any;
		const token = ((await (await postRetrieve(completed.retrievalCode)).json()) as any).chestToken;

		const response = await fetchDownload(token, uploaded.uploadedFiles[0].fileId);

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Disposition')).not.toMatch(/[\r\n]/);
		expect(response.headers.get('Content-Disposition')).toContain("filename*=UTF-8''");
		await response.text();
	});
});
