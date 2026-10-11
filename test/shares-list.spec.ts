import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestSession, ownerSignIn, setupTestEnvironment, testFetch, TEST_ORIGIN } from './utils/test-setup';

async function makeShare(files: Array<{ name: string; content: string }>, validityDays = 7): Promise<{ code: string; sessionId: string }> {
	const { sessionId, uploadToken } = await createTestSession();
	const form = new FormData();
	for (const f of files) form.append('files', new File([f.content], f.name, { type: 'text/plain' }));
	const uploaded = await testFetch(`${TEST_ORIGIN}/api/upload-sessions/${sessionId}/files`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${uploadToken}` },
		body: form,
	});
	const fileIds = ((await uploaded.json()) as any).uploadedFiles.map((f: any) => f.fileId);
	const done = await testFetch(`${TEST_ORIGIN}/api/upload-sessions/${sessionId}/complete`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${uploadToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ fileIds, validityDays }),
	});
	return { code: ((await done.json()) as any).retrievalCode, sessionId };
}

async function list(query = '', withOwner = true) {
	const headers: Record<string, string> = {};
	if (withOwner) headers.Cookie = (await ownerSignIn()).cookie;
	return testFetch(`${TEST_ORIGIN}/api/admin/shares${query}`, { headers });
}

async function patchJson(key: string, change: (value: any) => void) {
	const object = await env.R2_STORAGE.get(key);
	const value = JSON.parse(await object!.text());
	change(value);
	await env.R2_STORAGE.put(key, JSON.stringify(value));
}

describe('GET /api/admin/shares', () => {
	beforeEach(setupTestEnvironment);

	it('rejects a caller who is not signed in', async () => {
		const response = await list('', false);
		expect(response.status).toBe(401);
	});

	it('lists a live share with its code, file count, total size and times, and is not cacheable', async () => {
		const { code, sessionId } = await makeShare([
			{ name: 'a.txt', content: '12345' },
			{ name: 'b.txt', content: '1234567' },
		]);
		const response = await list();
		expect(response.status).toBe(200);
		expect(response.headers.get('Cache-Control')).toBe('no-store');
		const data = (await response.json()) as any;
		expect(data.cursor).toBeNull();
		expect(data.shares).toHaveLength(1);
		expect(data.shares[0]).toMatchObject({ sessionId, retrievalCode: code, fileCount: 2, totalSize: 12 });
		expect(data.shares[0].expiresAt).toBeGreaterThan(data.shares[0].createdAt);
	});

	it('lists a permanent share with a null expiry', async () => {
		await makeShare([{ name: 'p.txt', content: 'x' }], -1);
		const data = (await (await list()).json()) as any;
		expect(data.shares[0].expiresAt).toBeNull();
	});

	it('skips expired, orphaned, unfinished and corrupt records instead of listing them', async () => {
		const live = await makeShare([{ name: 'live.txt', content: 'x' }]);
		const expired = await makeShare([{ name: 'old.txt', content: 'x' }]);
		const orphan = await makeShare([{ name: 'orphan.txt', content: 'x' }]);
		const finalizing = await makeShare([{ name: 'fin.txt', content: 'x' }]);
		const corrupt = await makeShare([{ name: 'bad.txt', content: 'x' }]);

		const past = Math.floor(Date.now() / 1000) - 10;
		await patchJson(`codes/${expired.code}`, (m) => (m.expiresAt = past));
		await patchJson(`sessions/${expired.sessionId}`, (s) => (s.expiresAt = past));
		await env.R2_STORAGE.delete(`sessions/${orphan.sessionId}`);
		await patchJson(`sessions/${finalizing.sessionId}`, (s) => (s.status = 'FINALIZING'));
		await env.R2_STORAGE.put(`codes/${corrupt.code}`, '{not json');

		const data = (await (await list()).json()) as any;
		expect(data.shares.map((s: any) => s.retrievalCode)).toEqual([live.code]);
	});

	it('pages through all shares without repeats or gaps', async () => {
		const made = [];
		for (let i = 0; i < 5; i++) made.push((await makeShare([{ name: `f${i}.txt`, content: 'x' }])).code);
		const seen: string[] = [];
		let cursor: string | null = null;
		let pages = 0;
		do {
			const query: string = `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
			const data = (await (await list(query)).json()) as any;
			expect(data.shares.length).toBeLessThanOrEqual(2);
			seen.push(...data.shares.map((s: any) => s.retrievalCode));
			cursor = data.cursor;
			pages++;
		} while (cursor && pages < 10);
		expect([...seen].sort()).toEqual([...made].sort());
		expect(new Set(seen).size).toBe(seen.length);
		expect(pages).toBeGreaterThan(1);
	});

	it.each(['0', '51', 'abc', '1.5', '-1'])('refuses limit=%s', async (limit) => {
		expect((await list(`?limit=${limit}`)).status).toBe(400);
	});
});
