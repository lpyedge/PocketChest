import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { getSessionRecord } from '../src/worker/session';
import { resetStorage, setupTestEnvironment, createTestSession, testFetch, postRetrieve, fetchDownload } from './utils/test-setup';

const original = env.R2_STORAGE;
const bucket = () => original;

async function createChest() {
	const { sessionId, uploadToken } = await createTestSession();
	const formData = new FormData();
	formData.append('textItems', JSON.stringify({ content: 'hello', filename: 'a.txt' }));
	const upload = (await (
		await testFetch(`http://example.com/api/upload-sessions/${sessionId}/files`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${uploadToken}` },
			body: formData,
		})
	).json()) as any;
	const fileId = upload.uploadedFiles[0].fileId as string;
	const completed = (await (
		await testFetch(`http://example.com/api/upload-sessions/${sessionId}/complete`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${uploadToken}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ fileIds: [fileId], validityDays: 7 }),
		})
	).json()) as any;
	const code = completed.retrievalCode as string;
	const retrieved = (await (await postRetrieve(code)).json()) as any;
	return { sessionId, fileId, code, chestToken: retrieved.chestToken as string };
}

async function setSessionExpiry(sessionId: string, expiresAt: number | null) {
	const { record } = (await getSessionRecord(bucket(), sessionId))!;
	await bucket().put(`sessions/${sessionId}`, JSON.stringify({ ...record, expiresAt }));
}

async function setManifestExpiry(code: string, expiresAt: number | null) {
	const manifest = (await (await bucket().get(`codes/${code}`))!.json()) as any;
	await bucket().put(`codes/${code}`, JSON.stringify({ ...manifest, expiresAt }));
}

function sessionReadsFail(): R2Bucket {
	return new Proxy(bucket(), {
		get(target, property) {
			if (property === 'get') {
				return (key: string, ...rest: unknown[]) =>
					key.startsWith('sessions/')
						? Promise.reject(new Error('injected R2 read failure'))
						: (target.get as any).call(target, key, ...rest);
			}
			const value = (target as any)[property];
			return typeof value === 'function' ? value.bind(target) : value;
		},
	}) as R2Bucket;
}

describe('R09 the session is the authority for a chest, and a storage fault is not a 404', () => {
	beforeEach(async () => {
		await resetStorage();
		await setupTestEnvironment();
	});
	afterEach(() => {
		vi.restoreAllMocks();
		Object.defineProperty(env, 'R2_STORAGE', { value: bucket(), configurable: true });
	});

	it('serves a consistent chest', async () => {
		const chest = await createChest();
		expect((await postRetrieve(chest.code)).status).toBe(200);
		const download = await fetchDownload(chest.chestToken, chest.fileId);
		expect(download.status).toBe(200);
		expect(await download.text()).toBe('hello');
	});

	it('C11: refuses retrieval and download when the session says expired but the manifest still says valid', async () => {
		const chest = await createChest();
		await setSessionExpiry(chest.sessionId, Math.floor(Date.now() / 1000) - 5);

		const retrieve = await postRetrieve(chest.code);
		expect(retrieve.status).toBe(404);
		await retrieve.text();
		const download = await fetchDownload(chest.chestToken, chest.fileId);
		expect(download.status).toBe(404);
		await download.text();
	});

	it('C11: refuses when the manifest says expired but the session says valid, and reports the mismatch without the code', async () => {
		const chest = await createChest();
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		await setManifestExpiry(chest.code, Math.floor(Date.now() / 1000) - 5);

		const retrieve = await postRetrieve(chest.code);
		expect(retrieve.status).toBe(404);
		await retrieve.text();
		const download = await fetchDownload(chest.chestToken, chest.fileId);
		expect(download.status).toBe(404);
		await download.text();

		expect(warn).toHaveBeenCalled();
		const logged = warn.mock.calls.map((call) => call.join(' ')).join('\n');
		expect(logged).toContain(chest.sessionId);
		expect(logged).not.toContain(chest.code);
	});

	it('C11: a permanent session with a manifest that claims an expiry is refused too', async () => {
		const chest = await createChest();
		await setSessionExpiry(chest.sessionId, null);
		vi.spyOn(console, 'warn').mockImplementation(() => undefined);

		const retrieve = await postRetrieve(chest.code);
		expect(retrieve.status).toBe(404);
		await retrieve.text();
	});

	it('answers 503, not 404, when the session cannot be read, on retrieval and on download', async () => {
		const chest = await createChest();
		Object.defineProperty(env, 'R2_STORAGE', { value: sessionReadsFail(), configurable: true });
		vi.spyOn(console, 'error').mockImplementation(() => undefined);

		const retrieve = await postRetrieve(chest.code);
		expect(retrieve.status).toBe(503);
		expect(((await retrieve.json()) as any).code).toBe('STORAGE_UNAVAILABLE');
		expect(retrieve.headers.get('Retry-After')).toBeTruthy();
		const download = await fetchDownload(chest.chestToken, chest.fileId);
		expect(download.status).toBe(503);
		await download.text();

		// Once storage is back the same code works again
		Object.defineProperty(env, 'R2_STORAGE', { value: bucket(), configurable: true });
		expect((await postRetrieve(chest.code)).status).toBe(200);
	});

	it('does not serve a chest whose session record is corrupt', async () => {
		const chest = await createChest();
		await bucket().put(`sessions/${chest.sessionId}`, '{"broken":true}');
		vi.spyOn(console, 'error').mockImplementation(() => undefined);

		const retrieve = await postRetrieve(chest.code);
		expect(retrieve.status).toBe(404);
		await retrieve.text();
	});
});
