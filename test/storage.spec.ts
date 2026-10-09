import { describe, it, expect, beforeEach } from 'vitest';
import { env, createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import worker from '../src/worker/index';
import { cleanupExpired, ABANDONED_SESSION_SECONDS } from '../src/worker/storage';
import { getCurrentTimestamp } from '../src/worker/utils';
import { setupTestEnvironment, createTestSession, testFetch } from './utils/test-setup';

const DAY = 24 * 60 * 60;

async function listKeys(prefix?: string): Promise<string[]> {
	const page = await env.R2_STORAGE.list({ prefix });
	return page.objects.map((object) => object.key);
}

async function uploadText(sessionId: string, uploadToken: string, content: string): Promise<string> {
	const formData = new FormData();
	formData.append('textItems', JSON.stringify({ content, filename: `${content}.txt` }));
	const response = await testFetch(`http://example.com/api/chest/${sessionId}/upload`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${uploadToken}` },
		body: formData,
	});
	const data = (await response.json()) as any;
	return data.uploadedFiles[0].fileId;
}

function complete(sessionId: string, uploadToken: string, fileIds: string[], validityDays: number) {
	return testFetch(`http://example.com/api/chest/${sessionId}/complete`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${uploadToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ fileIds, validityDays }),
	});
}

async function createChest(content: string, validityDays: number) {
	const { sessionId, uploadToken } = await createTestSession();
	const fileId = await uploadText(sessionId, uploadToken, content);
	const response = await complete(sessionId, uploadToken, [fileId], validityDays);
	const { retrievalCode } = (await response.json()) as any;
	return { sessionId, fileId, retrievalCode: retrievalCode as string };
}

async function retrieve(code: string) {
	return testFetch(`http://example.com/api/retrieve/${code}`);
}

describe('R2 storage lifecycle', () => {
	beforeEach(async () => {
		await setupTestEnvironment();
	});

	it('stores a manifest and expiry index, and closes the session on completion', async () => {
		const { sessionId, fileId, retrievalCode } = await createChest('hello', 7);

		expect(await listKeys('pending/')).toEqual([]);
		expect(await listKeys('codes/')).toEqual([`codes/${retrievalCode}`]);
		const [indexKey] = await listKeys('expiry/');
		expect(indexKey).toMatch(new RegExp(`^expiry/\\d{10}/${retrievalCode}$`));

		const manifest = (await (await env.R2_STORAGE.get(`codes/${retrievalCode}`))!.json()) as any;
		expect(manifest).toMatchObject({
			version: 1,
			sessionId,
			files: [{ fileId, filename: 'hello.txt', size: 5, mimeType: 'text/plain', isText: true, fileExtension: 'txt' }],
		});
		expect(indexKey).toBe(`expiry/${String(manifest.expiresAt).padStart(10, '0')}/${retrievalCode}`);
	});

	it('does not write an expiry index for permanent chests', async () => {
		await createChest('forever', -1);
		expect(await listKeys('expiry/')).toEqual([]);
	});

	it('returns the same code when the same session is completed again with the same input', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const formData = new FormData();
		formData.append('textItems', JSON.stringify({ content: 'once', filename: 'once.txt' }));
		const upload = await testFetch(`http://example.com/api/chest/${sessionId}/upload`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${uploadToken}` },
			body: formData,
		});
		const fileId = ((await upload.json()) as any).uploadedFiles[0].fileId;

		const body = JSON.stringify({ fileIds: [fileId], validityDays: 7 });
		const headers = { Authorization: `Bearer ${uploadToken}`, 'Content-Type': 'application/json' };
		const first = (await (
			await testFetch(`http://example.com/api/chest/${sessionId}/complete`, { method: 'POST', headers, body })
		).json()) as any;
		const second = await testFetch(`http://example.com/api/chest/${sessionId}/complete`, { method: 'POST', headers, body });

		expect(second.status).toBe(200);
		expect(((await second.json()) as any).retrievalCode).toBe(first.retrievalCode);
	});

	it('rejects duplicate file IDs', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const fileId = await uploadText(sessionId, uploadToken, 'dup');

		const response = await complete(sessionId, uploadToken, [fileId, fileId], 7);
		expect(response.status).toBe(400);
		await response.text();
	});

	it('treats a chest past its expiry as not found before cleanup runs', async () => {
		const { retrievalCode } = await createChest('stale', 1);
		const object = await env.R2_STORAGE.get(`codes/${retrievalCode}`);
		const manifest = (await object!.json()) as any;
		await env.R2_STORAGE.put(`codes/${retrievalCode}`, JSON.stringify({ ...manifest, expiresAt: getCurrentTimestamp() - 1 }));

		const response = await retrieve(retrievalCode);
		expect(response.status).toBe(404);
		expect(((await response.json()) as any).code).toBe('CHEST_NOT_FOUND');
	});

	it('only serves files listed in the chest the token was issued for', async () => {
		const first = await createChest('first', 7);
		const second = await createChest('second', 7);
		const { chestToken } = (await (await retrieve(first.retrievalCode)).json()) as any;

		const own = await testFetch(`http://example.com/api/download/${first.fileId}`, {
			headers: { Authorization: `Bearer ${chestToken}` },
		});
		expect(own.status).toBe(200);
		expect(await own.text()).toBe('first');

		const other = await testFetch(`http://example.com/api/download/${second.fileId}`, {
			headers: { Authorization: `Bearer ${chestToken}` },
		});
		expect(other.status).toBe(404);
		await other.text();
	});

	describe('cleanup', () => {
		it('deletes expired chests with their files and keeps the rest', async () => {
			const expiring = await createChest('one-day', 1);
			const longer = await createChest('week', 7);
			const permanent = await createChest('permanent', -1);

			const result = await cleanupExpired(env.R2_STORAGE, getCurrentTimestamp() + 2 * DAY);

			expect(result).toMatchObject({ expiredChests: 1, abandonedSessions: 0, deletedObjects: 1, errors: [] });
			expect(await listKeys(`${expiring.sessionId}/`)).toEqual([]);
			expect(await listKeys('codes/')).toEqual([`codes/${longer.retrievalCode}`, `codes/${permanent.retrievalCode}`].sort());
			expect(await listKeys('expiry/')).toHaveLength(1);
			expect((await retrieve(expiring.retrievalCode)).status).toBe(404);
			expect((await retrieve(permanent.retrievalCode)).status).toBe(200);
		});

		it('deletes upload sessions abandoned for more than 48 hours', async () => {
			const { sessionId, uploadToken } = await createTestSession();
			await uploadText(sessionId, uploadToken, 'abandoned');

			const tooEarly = await cleanupExpired(env.R2_STORAGE, getCurrentTimestamp() + ABANDONED_SESSION_SECONDS - 60);
			expect(tooEarly.abandonedSessions).toBe(0);
			expect(await listKeys(`${sessionId}/`)).toHaveLength(1);

			const result = await cleanupExpired(env.R2_STORAGE, getCurrentTimestamp() + ABANDONED_SESSION_SECONDS + 60);
			expect(result).toMatchObject({ abandonedSessions: 1, deletedObjects: 1, errors: [] });
			expect((await listKeys()).filter((key) => !key.startsWith('maintenance/'))).toEqual([]);
		});

		it('runs from the cron trigger without touching live chests', async () => {
			const { retrievalCode } = await createChest('live', 1);

			const ctx = createExecutionContext();
			await worker.scheduled(createScheduledController(), env, ctx);
			await waitOnExecutionContext(ctx);

			expect((await retrieve(retrievalCode)).status).toBe(200);
		});
	});
});
