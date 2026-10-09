import { describe, it, expect, beforeEach } from 'vitest';
import { getSessionRecord } from '../src/worker/session';
import { env } from 'cloudflare:test';
import { resetStorage, setupTestEnvironment, createTestSession, testFetch } from './utils/test-setup';

async function uploadText(sessionId: string, uploadToken: string): Promise<string> {
	const formData = new FormData();
	formData.append('textItems', JSON.stringify({ content: 'x', filename: 'x.txt' }));
	const response = await testFetch(`http://example.com/api/upload-sessions/${sessionId}/files`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${uploadToken}` },
		body: formData,
	});
	return ((await response.json()) as any).uploadedFiles[0].fileId;
}

function complete(sessionId: string, uploadToken: string, fileIds: string[], validityDays: number) {
	return testFetch(`http://example.com/api/upload-sessions/${sessionId}/complete`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${uploadToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ fileIds, validityDays }),
	});
}

describe('R04 the two-week option is fourteen days', () => {
	beforeEach(async () => {
		await resetStorage();
		await setupTestEnvironment();
	});

	it('C09: 14 days is accepted and expires 14 * 86400 seconds after it was completed', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const fileId = await uploadText(sessionId, uploadToken);
		const before = Math.floor(Date.now() / 1000);

		const response = await complete(sessionId, uploadToken, [fileId], 14);
		const after = Math.floor(Date.now() / 1000);

		expect(response.status).toBe(200);
		const body = (await response.json()) as any;
		const record = (await getSessionRecord(env.R2_STORAGE, sessionId))!.record;
		expect(record.validityDays).toBe(14);
		expect(record.expiresAt!).toBeGreaterThanOrEqual(before + 14 * 86400);
		expect(record.expiresAt!).toBeLessThanOrEqual(after + 14 * 86400);
		expect(Date.parse(body.expiryDate) / 1000).toBe(record.expiresAt);
	});

	it('C09: 15 days is no longer a valid period', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const fileId = await uploadText(sessionId, uploadToken);

		const response = await complete(sessionId, uploadToken, [fileId], 15);

		expect(response.status).toBe(400);
		expect(((await response.json()) as any).code).toBe('INVALID_REQUEST');
	});

	it('still accepts 1, 3, 7 and permanent', async () => {
		for (const days of [1, 3, 7, -1]) {
			const { sessionId, uploadToken } = await createTestSession();
			const fileId = await uploadText(sessionId, uploadToken);
			const response = await complete(sessionId, uploadToken, [fileId], days);
			expect(response.status).toBe(200);
			await response.text();
		}
	});
});
