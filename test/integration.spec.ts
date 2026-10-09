import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createTestSession, resetStorage, setupTestEnvironment, testFetch, postRetrieve, fetchDownload } from './utils/test-setup';

describe('Integration Tests', () => {
	beforeAll(async () => {
		await resetStorage();
	});

	beforeEach(async () => {
		await setupTestEnvironment();
	});

	it('should handle complete end-to-end workflow', async () => {
		// 1. Create chest
		const createData = await createTestSession();

		// 2. Upload mixed files and text
		const formData = new FormData();
		formData.append('files', new File(['e2e file content'], 'e2e-file.txt'));
		formData.append(
			'textItems',
			JSON.stringify({
				content: 'End-to-end text content',
				filename: 'e2e-text.txt',
			}),
		);

		const uploadResponse = await testFetch(`http://example.com/api/upload-sessions/${createData.sessionId}/files`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${createData.uploadToken}` },
			body: formData,
		});
		expect(uploadResponse.status).toBe(200);
		const uploadData = (await uploadResponse.json()) as any;

		// 3. Complete upload
		const completeResponse = await testFetch(`http://example.com/api/upload-sessions/${createData.sessionId}/complete`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${createData.uploadToken}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				fileIds: uploadData.uploadedFiles.map((f: any) => f.fileId),
				validityDays: 1,
			}),
		});
		expect(completeResponse.status).toBe(200);
		const completeData = (await completeResponse.json()) as any;

		// 4. Retrieve chest contents
		const retrieveResponse = await postRetrieve(completeData.retrievalCode);
		expect(retrieveResponse.status).toBe(200);
		const retrieveData = (await retrieveResponse.json()) as any;
		expect(retrieveData.files).toHaveLength(2);

		// 5. Download both files
		for (const file of retrieveData.files) {
			const downloadResponse = await fetchDownload(retrieveData.chestToken, file.fileId);
			expect(downloadResponse.status).toBe(200);

			const content = await downloadResponse.text();
			if (file.isText) {
				expect(content).toBe('End-to-end text content');
			} else {
				expect(content).toBe('e2e file content');
			}
		}
	});

	it('should handle multipart upload in end-to-end workflow', async () => {
		// 1. Create chest
		const createData = await createTestSession();

		// 2. Create multipart upload
		const multipartCreateResponse = await testFetch(`http://example.com/api/upload-sessions/${createData.sessionId}/multipart/create`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${createData.uploadToken}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				filename: 'e2e-multipart.txt',
				mimeType: 'text/plain',
				fileSize: new TextEncoder().encode('End-to-end multipart content').byteLength,
			}),
		});
		const multipartCreateData = (await multipartCreateResponse.json()) as any;

		// 3. Upload part
		const partData = new TextEncoder().encode('End-to-end multipart content');
		const uploadPartResponse = await testFetch(
			`http://example.com/api/upload-sessions/${createData.sessionId}/multipart/${multipartCreateData.fileId}/parts/1`,
			{
				method: 'PUT',
				headers: {
					Authorization: `Bearer ${multipartCreateData.uploadId}`,
				},
				body: partData,
			},
		);
		const partDataResult = (await uploadPartResponse.json()) as any;

		// 4. Complete multipart upload
		const completeMultipartResponse = await testFetch(
			`http://example.com/api/upload-sessions/${createData.sessionId}/multipart/${multipartCreateData.fileId}/complete`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${multipartCreateData.uploadId}`,
					'Content-Type': 'application/json',
				},
				body: JSON.stringify({
					parts: [
						{
							partNumber: 1,
							etag: partDataResult.etag,
						},
					],
				}),
			},
		);
		expect(completeMultipartResponse.status).toBe(200);

		// 5. Complete session
		const completeSessionResponse = await testFetch(`http://example.com/api/upload-sessions/${createData.sessionId}/complete`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${createData.uploadToken}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				fileIds: [multipartCreateData.fileId],
				validityDays: 1,
			}),
		});
		expect(completeSessionResponse.status).toBe(200);
		const completeSessionData = (await completeSessionResponse.json()) as any;

		// 6. Retrieve and download
		const retrieveResponse = await postRetrieve(completeSessionData.retrievalCode);
		const retrieveData = (await retrieveResponse.json()) as any;

		const downloadResponse = await fetchDownload(retrieveData.chestToken, retrieveData.files[0].fileId);
		expect(downloadResponse.status).toBe(200);

		const content = await downloadResponse.text();
		expect(content).toBe('End-to-end multipart content');
	});

	it('should handle error scenarios gracefully throughout workflow', async () => {
		// 1. Try to upload to non-existent session
		const formData = new FormData();
		formData.append('files', new File(['test'], 'test.txt'));

		const uploadResponse = await testFetch('http://example.com/api/upload-sessions/fake-session-id/files', {
			method: 'POST',
			headers: {
				Authorization: 'Bearer fake-token',
			},
			body: formData,
		});
		expect(uploadResponse.status).toBe(401); // JWT validation fails first

		// 2. Try to retrieve non-existent chest
		const retrieveResponse = await postRetrieve('FAKE01');
		expect(retrieveResponse.status).toBe(404);

		// 3. Try to download non-existent file
		const downloadResponse = await testFetch('http://example.com/api/download/fake-file-id', {
			headers: {
				Authorization: 'Bearer fake-token',
			},
		});
		expect(downloadResponse.status).toBe(401);
	});
});
