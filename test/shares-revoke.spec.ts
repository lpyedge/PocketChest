import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { cleanupExpired } from '../src/worker/storage';
import {
	createTestSession,
	fetchDownload,
	ownerSignIn,
	postRetrieve,
	setupTestEnvironment,
	testFetch,
	TEST_ORIGIN,
} from './utils/test-setup';

async function makeShare(name: string, validityDays = 7) {
	const { sessionId, uploadToken } = await createTestSession();
	const form = new FormData();
	form.append('files', new File([`content of ${name}`], name, { type: 'text/plain' }));
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
	return { code: ((await done.json()) as any).retrievalCode as string, sessionId, fileId: fileIds[0] as string };
}

async function revoke(sessionId: string, auth: 'full' | 'no-csrf' | 'none' = 'full') {
	const headers: Record<string, string> = { Origin: TEST_ORIGIN };
	if (auth !== 'none') {
		const owner = await ownerSignIn();
		headers.Cookie = owner.cookie;
		if (auth === 'full') headers['X-PocketChest-CSRF'] = owner.csrfToken;
	}
	return testFetch(`${TEST_ORIGIN}/api/admin/shares/${sessionId}`, { method: 'DELETE', headers });
}

const exists = async (key: string) => (await env.R2_STORAGE.head(key)) !== null;
const prefixCount = async (prefix: string) => (await env.R2_STORAGE.list({ prefix })).objects.length;

describe('DELETE /api/admin/shares/:sessionId', () => {
	beforeEach(setupTestEnvironment);

	it('needs the Owner and the CSRF token', async () => {
		const share = await makeShare('a.txt');
		expect((await revoke(share.sessionId, 'none')).status).toBe(401);
		expect((await revoke(share.sessionId, 'no-csrf')).status).toBe(403);
		expect((await postRetrieve(share.code)).status).toBe(200);
	});

	it('stops retrieval and downloads at once, even with a retrieval token issued before', async () => {
		const share = await makeShare('a.txt');
		const retrieved = (await (await postRetrieve(share.code)).json()) as any;

		const response = await revoke(share.sessionId);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ revoked: true, contentRemoved: true });

		expect((await postRetrieve(share.code)).status).toBe(404);
		const download = await fetchDownload(retrieved.chestToken, share.fileId);
		expect(download.status).not.toBe(200);
	});

	it('removes the share completely and leaves other shares alone', async () => {
		const gone = await makeShare('gone.txt');
		const kept = await makeShare('kept.txt');
		await revoke(gone.sessionId);

		expect(await exists(`codes/${gone.code}`)).toBe(false);
		expect(await exists(`sessions/${gone.sessionId}`)).toBe(false);
		expect(await exists(`revoked/${gone.sessionId}`)).toBe(false);
		expect(await prefixCount(`${gone.sessionId}/`)).toBe(0);
		expect(await prefixCount('expiry/')).toBe(1);

		expect((await postRetrieve(kept.code)).status).toBe(200);
		expect(await prefixCount(`${kept.sessionId}/`)).toBe(1);
	});

	it('answers 404 for an unknown session, an unfinished one and a repeat', async () => {
		expect((await revoke('00000000-0000-4000-8000-000000000000')).status).toBe(404);
		const open = await createTestSession();
		expect((await revoke(open.sessionId)).status).toBe(404);
		const share = await makeShare('a.txt');
		expect((await revoke(share.sessionId)).status).toBe(200);
		expect((await revoke(share.sessionId)).status).toBe(404);
	});

	it('works for a permanent share', async () => {
		const share = await makeShare('p.txt', -1);
		expect((await revoke(share.sessionId)).status).toBe(200);
		expect((await postRetrieve(share.code)).status).toBe(404);
	});

	it('keeps the share refused when content removal fails, and cleanup finishes it', async () => {
		const share = await makeShare('a.txt');
		const spy = vi.spyOn(env.R2_STORAGE, 'delete').mockRejectedValue(new Error('R2 unavailable'));
		let response: Response;
		try {
			response = await revoke(share.sessionId);
		} finally {
			spy.mockRestore();
		}
		expect(response.status).toBe(200);
		expect(((await response.json()) as any).contentRemoved).toBe(false);

		// Refused although the manifest and files are still stored
		expect(await exists(`codes/${share.code}`)).toBe(true);
		expect((await postRetrieve(share.code)).status).toBe(404);
		expect(await exists(`revoked/${share.sessionId}`)).toBe(true);

		// Cleanup, even far in the future, neither revives nor misses it
		const result = await cleanupExpired(env.R2_STORAGE, Math.floor(Date.now() / 1000) + 60);
		expect(result.revokedPurged).toBe(1);
		expect(await exists(`codes/${share.code}`)).toBe(false);
		expect(await exists(`sessions/${share.sessionId}`)).toBe(false);
		expect(await exists(`revoked/${share.sessionId}`)).toBe(false);
		expect(await prefixCount(`${share.sessionId}/`)).toBe(0);
	});

	it('never touches another session share when a revoked code was reissued', async () => {
		const share = await makeShare('a.txt');
		const other = await makeShare('b.txt');
		const spy = vi.spyOn(env.R2_STORAGE, 'delete').mockRejectedValue(new Error('R2 unavailable'));
		try {
			await revoke(share.sessionId);
		} finally {
			spy.mockRestore();
		}
		// Point the revoked share's code at the other session's manifest, as if the code had been reissued
		const manifest = await (await env.R2_STORAGE.get(`codes/${other.code}`))!.text();
		await env.R2_STORAGE.put(`codes/${share.code}`, manifest);

		await cleanupExpired(env.R2_STORAGE, Math.floor(Date.now() / 1000) + 60);
		// The other share is untouched: its claim, record, content and retrieval all still work
		expect(await exists(`codes/${other.code}`)).toBe(true);
		expect(await exists(`sessions/${other.sessionId}`)).toBe(true);
		expect(await prefixCount(`${other.sessionId}/`)).toBe(1);
		expect((await postRetrieve(other.code)).status).toBe(200);
		expect(await exists(`sessions/${share.sessionId}`)).toBe(false);
	});

	it('drops a leftover marker for a share that was never revoked, only once it is stale', async () => {
		const share = await makeShare('a.txt');
		await env.R2_STORAGE.put(`revoked/${share.sessionId}`, '');
		const now = Math.floor(Date.now() / 1000);
		await cleanupExpired(env.R2_STORAGE, now);
		expect(await exists(`revoked/${share.sessionId}`)).toBe(true);
		await cleanupExpired(env.R2_STORAGE, now + 2 * 60 * 60);
		expect(await exists(`revoked/${share.sessionId}`)).toBe(false);
		expect(await exists(`sessions/${share.sessionId}`)).toBe(true);
	});
});
