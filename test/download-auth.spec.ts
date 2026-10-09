import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { createDownloadJWT } from '../src/worker/utils';
import { getSessionRecord } from '../src/worker/session';
import { resetStorage, setupTestEnvironment, createTestSession, testFetch, postRetrieve } from './utils/test-setup';

const bucket = () => env.R2_STORAGE;

interface Chest {
	sessionId: string;
	code: string;
	chestToken: string;
	files: { fileId: string; filename: string }[];
}

async function createChest(texts: { content: string; filename: string }[], validityDays = 7): Promise<Chest> {
	const { sessionId, uploadToken } = await createTestSession();
	const formData = new FormData();
	for (const text of texts) formData.append('textItems', JSON.stringify(text));
	const upload = (await (
		await testFetch(`http://example.com/api/upload-sessions/${sessionId}/files`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${uploadToken}` },
			body: formData,
		})
	).json()) as any;
	const fileIds = upload.uploadedFiles.map((f: any) => f.fileId);
	const completed = (await (
		await testFetch(`http://example.com/api/upload-sessions/${sessionId}/complete`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${uploadToken}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ fileIds, validityDays }),
		})
	).json()) as any;
	const retrieved = (await (await postRetrieve(completed.retrievalCode)).json()) as any;
	return {
		sessionId,
		code: completed.retrievalCode,
		chestToken: retrieved.chestToken,
		files: retrieved.files,
	};
}

function authorize(chestToken: string | null, fileId: string) {
	return testFetch('http://example.com/api/download/authorize', {
		method: 'POST',
		headers: { ...(chestToken ? { Authorization: `Bearer ${chestToken}` } : {}), 'Content-Type': 'application/json' },
		body: JSON.stringify({ fileId }),
	});
}

function download(fileId: string, cookie?: string, query = '') {
	return testFetch(`http://example.com/api/download/${fileId}${query}`, {
		headers: cookie ? { Cookie: cookie } : {},
	});
}

// The Cookie the browser would send, taken from the Set-Cookie of an authorize response
function cookieOf(response: Response, fileId: string): string {
	const setCookie = response.headers.get('Set-Cookie') ?? '';
	const pair = setCookie.split(';')[0];
	expect(pair.startsWith(`pc_dl_${fileId}=`)).toBe(true);
	return pair;
}

describe('download authorization', () => {
	beforeEach(async () => {
		await resetStorage();
		await setupTestEnvironment();
	});

	it('issues a per-file, path-scoped, short-lived Cookie with the required attributes', async () => {
		const chest = await createChest([{ content: 'hello', filename: 'hello.txt' }]);
		const response = await authorize(chest.chestToken, chest.files[0].fileId);

		expect(response.status).toBe(200);
		const setCookie = response.headers.get('Set-Cookie')!;
		expect(setCookie).toMatch(new RegExp(`^pc_dl_${chest.files[0].fileId}=`));
		expect(setCookie).toContain('HttpOnly');
		expect(setCookie).toContain('Secure');
		expect(setCookie).toContain('SameSite=Strict');
		expect(setCookie).toContain(`Path=/api/download/${chest.files[0].fileId}`);
		expect(setCookie).toContain('Max-Age=60');
		await response.text();
	});

	it('streams the file with the name stored in the chest, not one from the query string', async () => {
		const chest = await createChest([{ content: 'streamed', filename: 'report 2026.txt' }]);
		const fileId = chest.files[0].fileId;
		const cookie = cookieOf(await authorize(chest.chestToken, fileId), fileId);

		const response = await download(fileId, cookie, '?filename=evil.exe');

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('streamed');
		expect(response.headers.get('Content-Disposition')).toContain("filename*=UTF-8''report%202026.txt");
		expect(response.headers.get('Content-Disposition')).not.toContain('evil.exe');
		expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
		expect(response.headers.get('Cache-Control')).toBe('no-store');
	});

	it('refuses the retired ?token= and Bearer forms of download', async () => {
		const chest = await createChest([{ content: 'x', filename: 'x.txt' }]);
		const fileId = chest.files[0].fileId;

		const byQuery = await testFetch(`http://example.com/api/download/${fileId}?token=${chest.chestToken}`);
		const byBearer = await testFetch(`http://example.com/api/download/${fileId}`, {
			headers: { Authorization: `Bearer ${chest.chestToken}` },
		});

		expect(byQuery.status).toBe(401);
		expect(byBearer.status).toBe(401);
		await byQuery.text();
		await byBearer.text();
	});

	it('requires the chest token to authorize, and a file id that belongs to the chest', async () => {
		const chest = await createChest([{ content: 'x', filename: 'x.txt' }]);
		const other = await createChest([{ content: 'y', filename: 'y.txt' }]);

		const none = await authorize(null, chest.files[0].fileId);
		const foreign = await authorize(chest.chestToken, other.files[0].fileId);
		expect(none.status).toBe(401);
		expect(foreign.status).toBe(404);
		await none.text();
		await foreign.text();
	});

	it('does not accept a Cookie for a different file', async () => {
		const chest = await createChest([
			{ content: 'one', filename: 'one.txt' },
			{ content: 'two', filename: 'two.txt' },
		]);
		const [a, b] = chest.files.map((f) => f.fileId);
		const cookieA = cookieOf(await authorize(chest.chestToken, a), a);

		const response = await download(b, cookieA);
		expect(response.status).toBe(401);
		await response.text();
	});

	it('keeps several downloads from overwriting each other', async () => {
		const chest = await createChest([
			{ content: 'one', filename: 'one.txt' },
			{ content: 'two', filename: 'two.txt' },
		]);
		const [a, b] = chest.files.map((f) => f.fileId);
		const cookieA = cookieOf(await authorize(chest.chestToken, a), a);
		const cookieB = cookieOf(await authorize(chest.chestToken, b), b);

		const bodies = await Promise.all([download(a, cookieA).then((r) => r.text()), download(b, cookieB).then((r) => r.text())]);
		expect(bodies).toEqual(['one', 'two']);
	});

	it('refuses an expired download Cookie', async () => {
		const chest = await createChest([{ content: 'x', filename: 'x.txt' }]);
		const fileId = chest.files[0].fileId;
		const stale = await createDownloadJWT(
			{ sessionId: chest.sessionId, code: chest.code, fileId },
			env.JWT_SECRET,
			60,
			Math.floor(Date.now() / 1000) - 300,
		);

		const response = await download(fileId, `pc_dl_${fileId}=${stale}`);
		expect(response.status).toBe(401);
		await response.text();
	});

	it('refuses a valid Cookie once the chest has expired, even though the Cookie itself has not', async () => {
		const chest = await createChest([{ content: 'x', filename: 'x.txt' }]);
		const fileId = chest.files[0].fileId;
		const cookie = cookieOf(await authorize(chest.chestToken, fileId), fileId);

		// Move the chest's expiry into the past directly in R2
		const manifest = (await (await bucket().get(`codes/${chest.code}`))!.json()) as any;
		await bucket().put(`codes/${chest.code}`, JSON.stringify({ ...manifest, expiresAt: Math.floor(Date.now() / 1000) - 10 }));

		const response = await download(fileId, cookie);
		expect(response.status).toBe(404);
		await response.text();
	});

	it('refuses a Cookie whose session no longer agrees with the chest', async () => {
		const chest = await createChest([{ content: 'x', filename: 'x.txt' }]);
		const fileId = chest.files[0].fileId;
		const cookie = cookieOf(await authorize(chest.chestToken, fileId), fileId);

		const record = (await getSessionRecord(bucket(), chest.sessionId))!.record;
		await bucket().put(`sessions/${chest.sessionId}`, JSON.stringify({ ...record, retrievalCode: 'NOTHER' }));

		const response = await download(fileId, cookie);
		expect(response.status).toBe(404);
		await response.text();
	});
});
