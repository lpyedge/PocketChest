import { describe, it, expect, beforeEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { setupTestEnvironment, createTestSession, testFetch } from './utils/test-setup';

const codes = vi.hoisted(() => ({ queue: [] as string[] }));

vi.mock('../src/worker/utils', async (importOriginal) => {
	const original = await importOriginal<typeof import('../src/worker/utils')>();
	return { ...original, generateRetrievalCode: () => codes.queue.shift() ?? original.generateRetrievalCode() };
});

async function completeChest(): Promise<Response> {
	const { sessionId, uploadToken } = await createTestSession();
	const formData = new FormData();
	formData.append('textItems', JSON.stringify({ content: 'x', filename: 'x.txt' }));
	const upload = await testFetch(`http://example.com/api/chest/${sessionId}/upload`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${uploadToken}` },
		body: formData,
	});
	const { uploadedFiles } = (await upload.json()) as any;
	return testFetch(`http://example.com/api/chest/${sessionId}/complete`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${uploadToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ fileIds: [uploadedFiles[0].fileId], validityDays: 7 }),
	});
}

describe('Retrieval code collisions', () => {
	beforeEach(async () => {
		await setupTestEnvironment();
	});

	it('retries with a new code instead of overwriting an existing chest', async () => {
		codes.queue = ['AAAAAA'];
		const first = (await (await completeChest()).json()) as any;
		expect(first.retrievalCode).toBe('AAAAAA');
		const firstManifest = await (await env.R2_STORAGE.get('codes/AAAAAA'))!.text();

		codes.queue = ['AAAAAA', 'AAAAAA', 'BBBBBB'];
		const second = (await (await completeChest()).json()) as any;
		expect(second.retrievalCode).toBe('BBBBBB');
		expect(await (await env.R2_STORAGE.get('codes/AAAAAA'))!.text()).toBe(firstManifest);
	});

	it('gives up after repeated collisions without closing the session', async () => {
		codes.queue = ['CCCCCC'];
		await (await completeChest()).text();

		codes.queue = Array(5).fill('CCCCCC');
		const response = await completeChest();
		expect(response.status).toBe(500);
		expect(((await response.json()) as any).code).toBe('CODE_GENERATION_FAILED');
		expect((await env.R2_STORAGE.list({ prefix: 'pending/' })).objects).toHaveLength(1);
	});
});
