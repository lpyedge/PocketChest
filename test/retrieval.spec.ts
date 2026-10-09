import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { resetStorage, setupTestEnvironment, createTestSession, testFetch, postRetrieve } from './utils/test-setup';

describe('POST /api/retrieve - Get Chest Contents', () => {
	let retrievalCode: string;

	beforeAll(async () => {
		await resetStorage();
	});

	beforeEach(async () => {
		await setupTestEnvironment();

		const session = await createTestSession();
		const sessionId = session.sessionId;
		const uploadToken = session.uploadToken;

		const formData = new FormData();
		formData.append('files', new File(['test content'], 'test-retrieve.txt', { type: 'text/plain' }));
		formData.append('textItems', JSON.stringify({ content: 'Text content for retrieval', filename: 'text-retrieve.txt' }));

		const uploadResponse = await testFetch(`http://example.com/api/upload-sessions/${sessionId}/files`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${uploadToken}` },
			body: formData,
		});
		const fileIds = ((await uploadResponse.json()) as any).uploadedFiles.map((f: any) => f.fileId);

		const completeResponse = await testFetch(`http://example.com/api/upload-sessions/${sessionId}/complete`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${uploadToken}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ fileIds, validityDays: 7 }),
		});
		retrievalCode = ((await completeResponse.json()) as any).retrievalCode;
	});

	it('returns the file list and a retrieval token for a valid code in the request body', async () => {
		const response = await postRetrieve(retrievalCode);

		expect(response.status).toBe(200);
		const data = (await response.json()) as any;
		expect(data.files).toHaveLength(2);
		expect(data.files.find((f: any) => !f.isText)).toMatchObject({ filename: 'test-retrieve.txt', mimeType: 'text/plain', isText: false });
		expect(data.files.find((f: any) => f.isText)).toMatchObject({ filename: 'text-retrieve.txt', isText: true });
		expect(data.chestToken.split('.')).toHaveLength(3);
	});

	it('issues a short-lived retrieval token', async () => {
		const data = (await (await postRetrieve(retrievalCode)).json()) as any;
		const payload = JSON.parse(atob(data.chestToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));

		expect(payload.exp - payload.iat).toBeLessThanOrEqual(60 * 60);
	});

	it('marks the response as not cacheable', async () => {
		const response = await postRetrieve(retrievalCode);

		expect(response.headers.get('Cache-Control')).toBe('no-store');
		await response.text();
	});

	it('rejects a body that is not valid JSON', async () => {
		const response = await postRetrieve(undefined, { rawBody: '{not json' });

		expect(response.status).toBe(400);
		expect(((await response.json()) as any).code).toBe('INVALID_REQUEST');
	});

	it('rejects a missing or non-string code', async () => {
		for (const code of [undefined, null, 123, ['ABC123']]) {
			const response = await postRetrieve(code);
			expect(response.status).toBe(400);
			await response.text();
		}
	});

	it.each(['ABC12', 'ABC1234', 'abc123', 'ABC12!', ''])('rejects the malformed code %j with INVALID_CODE', async (code) => {
		const response = await postRetrieve(code);

		expect(response.status).toBe(400);
		expect(((await response.json()) as any).code).toBe('INVALID_CODE');
	});

	it('returns CHEST_NOT_FOUND for an unknown code, without echoing the code', async () => {
		const response = await postRetrieve('ZZZZZ9');
		const text = await response.text();

		expect(response.status).toBe(404);
		expect(JSON.parse(text).code).toBe('CHEST_NOT_FOUND');
		expect(text).not.toContain('ZZZZZ9');
	});

	it('no longer serves the old GET route that carried the code in the path', async () => {
		const response = await testFetch(`http://example.com/api/retrieve/${retrievalCode}`, { method: 'GET' });

		expect(response.status).toBe(404);
		expect(response.headers.get('Content-Type')).toContain('application/json');
		await response.text();
	});

	it('does not include CORS headers', async () => {
		const response = await postRetrieve(retrievalCode);

		expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
		await response.text();
	});
});
