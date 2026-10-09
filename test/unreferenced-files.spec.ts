import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { cleanupExpired } from '../src/worker/storage';
import { getCurrentTimestamp } from '../src/worker/utils';
import { resetStorage, setupTestEnvironment, createTestSession, testFetch } from './utils/test-setup';

const bucket = () => env.R2_STORAGE;
const HOUR = 3600;

async function uploadText(sessionId: string, uploadToken: string, name: string): Promise<string> {
	const formData = new FormData();
	formData.append('textItems', JSON.stringify({ content: name, filename: `${name}.txt` }));
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

async function objectIds(sessionId: string): Promise<string[]> {
	return (await bucket().list({ prefix: `${sessionId}/` })).objects.map((o) => o.key.split('/')[1]).sort();
}

describe('FIX-03 files a completed share does not reference are reclaimed', () => {
	beforeEach(async () => {
		await resetStorage();
		await setupTestEnvironment();
	});

	for (const validityDays of [7, -1]) {
		it(`removes the earlier upload of a retried file when the share (${validityDays} days) is completed`, async () => {
			const { sessionId, uploadToken } = await createTestSession();
			const oldA = await uploadText(sessionId, uploadToken, 'a');
			const newA = await uploadText(sessionId, uploadToken, 'a');
			const b = await uploadText(sessionId, uploadToken, 'b');

			const response = await complete(sessionId, uploadToken, [newA, b], validityDays);

			expect(response.status).toBe(200);
			expect(await objectIds(sessionId)).toEqual([newA, b].sort());
			expect(await bucket().head(`${sessionId}/${oldA}`)).toBeNull();
		});
	}

	it('lets the cleanup job remove an unreferenced object left in a completed session, after the grace period', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const a = await uploadText(sessionId, uploadToken, 'a');
		await complete(sessionId, uploadToken, [a], -1);
		const stray = crypto.randomUUID();
		await bucket().put(`${sessionId}/${stray}`, 'stray');

		const now = getCurrentTimestamp();
		await cleanupExpired(bucket(), now + HOUR);
		expect(await bucket().head(`${sessionId}/${stray}`)).not.toBeNull();

		const late = await cleanupExpired(bucket(), now + 49 * HOUR);
		expect(late.orphanObjects).toBe(1);
		expect(await objectIds(sessionId)).toEqual([a]);
	});

	it('never removes referenced files of a completed session', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const a = await uploadText(sessionId, uploadToken, 'a');
		const b = await uploadText(sessionId, uploadToken, 'b');
		await complete(sessionId, uploadToken, [a, b], -1);

		await cleanupExpired(bucket(), getCurrentTimestamp() + 49 * HOUR);

		expect(await objectIds(sessionId)).toEqual([a, b].sort());
	});
});
