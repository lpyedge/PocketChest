import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ownerSignIn, setupTestEnvironment, testFetch, TEST_ORIGIN } from './utils/test-setup';
import { createUploadJWT } from '../src/worker/utils';

const json = { 'Content-Type': 'application/json' };

// An upload the way the page starts it, keeping the Owner's cookie so the test can end that session
async function start() {
	const owner = await ownerSignIn();
	const created = await testFetch(`${TEST_ORIGIN}/api/upload-sessions`, {
		method: 'POST',
		headers: { ...json, Origin: TEST_ORIGIN, Cookie: owner.cookie, 'X-PocketChest-CSRF': owner.csrfToken },
		body: '{}',
	});
	const { sessionId, uploadToken } = (await created.json()) as { sessionId: string; uploadToken: string };
	return { owner, sessionId, uploadToken, base: `${TEST_ORIGIN}/api/upload-sessions/${sessionId}` };
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

async function signOut(owner: { cookie: string; csrfToken: string }) {
	const response = await testFetch(`${TEST_ORIGIN}/api/auth/logout`, {
		method: 'POST',
		headers: { ...json, Origin: TEST_ORIGIN, Cookie: owner.cookie, 'X-PocketChest-CSRF': owner.csrfToken },
		body: '{}',
	});
	expect(response.status).toBe(200);
}

function filesBody() {
	const form = new FormData();
	form.append('files', new File(['hello'], 'a.txt', { type: 'text/plain' }));
	return form;
}

const createMultipart = (base: string, token: string) =>
	testFetch(`${base}/multipart/create`, {
		method: 'POST',
		headers: { ...json, ...auth(token) },
		body: JSON.stringify({ filename: 'big.bin', mimeType: 'application/octet-stream', fileSize: 6 * 1024 * 1024 }),
	});

describe('upload tokens end with the Owner session that issued them', () => {
	beforeEach(setupTestEnvironment);

	it('works while the Owner is signed in', async () => {
		const { base, uploadToken } = await start();
		const response = await testFetch(`${base}/files`, { method: 'POST', headers: auth(uploadToken), body: filesBody() });
		expect(response.status).toBe(200);
	});

	it('refuses new files, a new multipart upload and Complete after sign-out', async () => {
		const { owner, base, uploadToken } = await start();
		const first = await testFetch(`${base}/files`, { method: 'POST', headers: auth(uploadToken), body: filesBody() });
		const fileIds = ((await first.json()) as any).uploadedFiles.map((f: any) => f.fileId);

		await signOut(owner);

		const files = await testFetch(`${base}/files`, { method: 'POST', headers: auth(uploadToken), body: filesBody() });
		expect(files.status).toBe(401);
		expect((await createMultipart(base, uploadToken)).status).toBe(401);
		const complete = await testFetch(`${base}/complete`, {
			method: 'POST',
			headers: { ...json, ...auth(uploadToken) },
			body: JSON.stringify({ fileIds, validityDays: 7 }),
		});
		expect(complete.status).toBe(401);
		// Nothing was published
		expect((await env.R2_STORAGE.list({ prefix: 'codes/' })).objects).toHaveLength(0);
	});

	it('refuses to finish a multipart upload after sign-out, but still lets a part land and the upload be aborted', async () => {
		const { owner, base, uploadToken } = await start();
		const created = (await (await createMultipart(base, uploadToken)).json()) as { fileId: string; uploadId: string };
		await signOut(owner);

		const part = await testFetch(`${base}/multipart/${created.fileId}/parts/1`, {
			method: 'PUT',
			headers: auth(created.uploadId),
			body: new Uint8Array(5 * 1024 * 1024),
		});
		expect(part.status).toBe(200);
		const etag = ((await part.json()) as any).etag;

		const complete = await testFetch(`${base}/multipart/${created.fileId}/complete`, {
			method: 'POST',
			headers: { ...json, ...auth(created.uploadId) },
			body: JSON.stringify({ parts: [{ partNumber: 1, etag }] }),
		});
		expect(complete.status).toBe(401);

		const abort = await testFetch(`${base}/multipart/${created.fileId}/abort`, { method: 'POST', headers: auth(created.uploadId) });
		expect(abort.status).toBe(200);
	});

	it('still lets the session be cancelled after sign-out, to free what it holds', async () => {
		const { owner, base, uploadToken } = await start();
		await signOut(owner);
		const cancel = await testFetch(`${base}/cancel`, { method: 'POST', headers: auth(uploadToken) });
		expect(cancel.status).toBe(200);
	});

	it('refuses the token after the Owner changed their sign-in setup (authVersion)', async () => {
		const { base, uploadToken } = await start();
		const object = await env.R2_STORAGE.get('auth/owner.json');
		const owner = JSON.parse(await object!.text());
		owner.authVersion += 1;
		await env.R2_STORAGE.put('auth/owner.json', JSON.stringify(owner));
		const response = await testFetch(`${base}/files`, { method: 'POST', headers: auth(uploadToken), body: filesBody() });
		expect(response.status).toBe(401);
	});

	it('refuses a token that carries no issuer claim (issued before this existed)', async () => {
		const { sessionId, base } = await start();
		const legacy = await createUploadJWT(sessionId, 'test-jwt-secret-for-vitest-only');
		const response = await testFetch(`${base}/files`, { method: 'POST', headers: auth(legacy), body: filesBody() });
		expect(response.status).toBe(401);
	});

	it('does not carry the cookie or session id in the token, only a hash', async () => {
		const { owner, uploadToken } = await start();
		const payload = JSON.parse(atob(uploadToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
		expect(payload.osh).toMatch(/^[0-9a-f]{64}$/);
		const sid = decodeURIComponent(owner.cookie.split('=')[1]);
		expect(JSON.stringify(payload)).not.toContain(sid);
	});

	it('does not read any Owner session on a multipart part (cost bound)', async () => {
		const { base, uploadToken } = await start();
		const created = (await (await createMultipart(base, uploadToken)).json()) as { fileId: string; uploadId: string };
		const spy = vi.spyOn(env.R2_STORAGE, 'get');
		try {
			const part = await testFetch(`${base}/multipart/${created.fileId}/parts/1`, {
				method: 'PUT',
				headers: auth(created.uploadId),
				body: new Uint8Array(5 * 1024 * 1024),
			});
			expect(part.status).toBe(200);
			const keys = spy.mock.calls.map(([key]) => String(key));
			expect(keys.filter((key) => key.startsWith('auth/'))).toEqual([]);
		} finally {
			spy.mockRestore();
		}
	});

	it('adds exactly two reads (Owner session, Owner record) to a files upload', async () => {
		const { base, uploadToken } = await start();
		const spy = vi.spyOn(env.R2_STORAGE, 'get');
		try {
			const response = await testFetch(`${base}/files`, { method: 'POST', headers: auth(uploadToken), body: filesBody() });
			expect(response.status).toBe(200);
			const keys = spy.mock.calls.map(([key]) => String(key));
			expect(keys.filter((key) => key.startsWith('auth/'))).toHaveLength(2);
		} finally {
			spy.mockRestore();
		}
	});
});
