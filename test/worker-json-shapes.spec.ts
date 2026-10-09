import { describe, it, expect, beforeEach } from 'vitest';
import { createTestSession, resetStorage, setupTestEnvironment, testFetch } from './utils/test-setup';

describe('REG-13 JSON bodies of the wrong shape are 400, never 500', () => {
	beforeEach(async () => {
		await resetStorage();
		await setupTestEnvironment();
	});

	const bodies = ['null', '[]', '1', '"text"', 'true'];

	function post(path: string, token: string | null, body: string) {
		return testFetch(`http://example.com${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
			body,
		});
	}

	for (const body of bodies) {
		it(`complete upload with ${body}`, async () => {
			const { sessionId, uploadToken } = await createTestSession();
			const response = await post(`/api/upload-sessions/${sessionId}/complete`, uploadToken, body);
			expect(response.status).toBe(400);
			expect(((await response.json()) as any).code).toBe('INVALID_REQUEST');
		});

		it(`multipart create with ${body}`, async () => {
			const { sessionId, uploadToken } = await createTestSession();
			const response = await post(`/api/upload-sessions/${sessionId}/multipart/create`, uploadToken, body);
			expect(response.status).toBe(400);
			await response.text();
		});

		it(`retrieve with ${body}`, async () => {
			const response = await post('/api/retrieve', null, body);
			expect(response.status).toBe(400);
			await response.text();
		});
	}

	it('multipart complete with a null part', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const created = await post(
			`/api/upload-sessions/${sessionId}/multipart/create`,
			uploadToken,
			JSON.stringify({ filename: 'a.bin', mimeType: 'application/octet-stream', fileSize: 10 }),
		);
		const { fileId, uploadId } = (await created.json()) as any;
		for (const parts of [[null], [1], ['x'], [[]]]) {
			const response = await post(`/api/upload-sessions/${sessionId}/multipart/${fileId}/complete`, uploadId, JSON.stringify({ parts }));
			expect(response.status).toBe(400);
			await response.text();
		}
	});
});
