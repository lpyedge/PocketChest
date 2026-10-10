import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { cleanupExpired } from '../src/worker/storage';
import { createTestSession, ownerSignIn, postRetrieve, setupTestEnvironment, testFetch, TEST_ORIGIN } from './utils/test-setup';

const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);

async function makeShare(name: string, validityDays = 1) {
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
	return { code: ((await done.json()) as any).retrievalCode as string, sessionId };
}

async function extend(sessionId: string, body: unknown, auth: 'full' | 'no-csrf' | 'none' = 'full') {
	const headers: Record<string, string> = { Origin: TEST_ORIGIN, 'Content-Type': 'application/json' };
	if (auth !== 'none') {
		const owner = await ownerSignIn();
		headers.Cookie = owner.cookie;
		if (auth === 'full') headers['X-PocketChest-CSRF'] = owner.csrfToken;
	}
	return testFetch(`${TEST_ORIGIN}/api/admin/shares/${sessionId}`, { method: 'PATCH', headers, body: JSON.stringify(body) });
}

async function readJson(key: string) {
	const object = await env.R2_STORAGE.get(key);
	return object ? JSON.parse(await object.text()) : null;
}
const indexKeys = async () => (await env.R2_STORAGE.list({ prefix: 'expiry/' })).objects.map((o) => o.key);
const expiryOf = async (share: { code: string; sessionId: string }) => ({
	session: (await readJson(`sessions/${share.sessionId}`)).expiresAt,
	manifest: (await readJson(`codes/${share.code}`)).expiresAt,
});

describe('PATCH /api/admin/shares/:sessionId', () => {
	beforeEach(setupTestEnvironment);

	it('needs the Owner and the CSRF token, and a valid choice', async () => {
		const share = await makeShare('a.txt');
		expect((await extend(share.sessionId, { validityDays: 7 }, 'none')).status).toBe(401);
		expect((await extend(share.sessionId, { validityDays: 7 }, 'no-csrf')).status).toBe(403);
		expect((await extend(share.sessionId, { validityDays: 5 })).status).toBe(400);
		expect((await extend(share.sessionId, {})).status).toBe(400);
	});

	it('moves session, manifest and index to the new expiry together', async () => {
		const share = await makeShare('a.txt', 1);
		const response = await extend(share.sessionId, { validityDays: 7 });
		expect(response.status).toBe(200);
		const { expiresAt } = (await response.json()) as any;
		expect(expiresAt).toBeGreaterThan(now() + 6 * DAY);
		expect(await expiryOf(share)).toEqual({ session: expiresAt, manifest: expiresAt });
		expect(await indexKeys()).toEqual([`expiry/${String(expiresAt).padStart(10, '0')}/${share.code}`]);
		expect((await postRetrieve(share.code)).status).toBe(200);
	});

	it('converts to permanent, removing the index, and then cannot be changed', async () => {
		const share = await makeShare('a.txt', 1);
		const response = await extend(share.sessionId, { validityDays: -1 });
		expect(((await response.json()) as any).expiresAt).toBeNull();
		expect(await expiryOf(share)).toEqual({ session: null, manifest: null });
		expect(await indexKeys()).toEqual([]);
		expect((await postRetrieve(share.code)).status).toBe(200);
		expect((await extend(share.sessionId, { validityDays: 14 })).status).toBe(409);
		expect((await extend(share.sessionId, { validityDays: -1 })).status).toBe(409);
	});

	it('never shortens a share', async () => {
		const share = await makeShare('a.txt', 14);
		const before = await expiryOf(share);
		const response = await extend(share.sessionId, { validityDays: 3 });
		expect(response.status).toBe(409);
		expect(((await response.json()) as any).code).toBe('EXPIRY_NOT_LATER');
		expect(await expiryOf(share)).toEqual(before);
	});

	it('can be repeated: expiry only moves later and everything stays consistent', async () => {
		const share = await makeShare('a.txt', 1);
		expect((await extend(share.sessionId, { validityDays: 7 })).status).toBe(200);
		const first = await expiryOf(share);
		const again = await extend(share.sessionId, { validityDays: 7 });
		expect([200, 409]).toContain(again.status);
		const second = await expiryOf(share);
		expect(second.session).toBeGreaterThanOrEqual(first.session);
		expect(second.manifest).toBe(second.session);
		expect(await indexKeys()).toHaveLength(1);
	});

	it('answers 404 for unknown, unfinished and revoked shares and does not revive a revoked one', async () => {
		expect((await extend('00000000-0000-4000-8000-000000000000', { validityDays: 7 })).status).toBe(404);
		const open = await createTestSession();
		expect((await extend(open.sessionId, { validityDays: 7 })).status).toBe(404);

		const share = await makeShare('a.txt');
		const owner = await ownerSignIn();
		const revoked = await testFetch(`${TEST_ORIGIN}/api/admin/shares/${share.sessionId}`, {
			method: 'DELETE',
			headers: { Origin: TEST_ORIGIN, Cookie: owner.cookie, 'X-PocketChest-CSRF': owner.csrfToken },
		});
		expect(revoked.status).toBe(200);
		expect((await extend(share.sessionId, { validityDays: 7 })).status).toBe(404);
		expect(await env.R2_STORAGE.head(`codes/${share.code}`)).toBeNull();
		expect(await indexKeys()).toEqual([]);
	});

	it('refuses an expired share', async () => {
		const share = await makeShare('a.txt');
		const past = now() - 10;
		for (const key of [`sessions/${share.sessionId}`, `codes/${share.code}`]) {
			const value = await readJson(key);
			value.expiresAt = past;
			await env.R2_STORAGE.put(key, JSON.stringify(value));
		}
		const response = await extend(share.sessionId, { validityDays: 7 });
		expect(response.status).toBe(409);
		expect(((await response.json()) as any).code).toBe('SHARE_EXPIRED');
	});

	it('leaves no stray index behind when the session changes underneath', async () => {
		const share = await makeShare('a.txt', 7);
		const before = await indexKeys();
		expect((await extend(share.sessionId, { validityDays: 3 })).status).toBe(409);
		expect(await indexKeys()).toEqual(before);
	});

	it.each(['manifest write', 'old index delete'])('a failure at the %s is repaired by repeating the request', async (step) => {
		const share = await makeShare('a.txt', 1);
		const original = env.R2_STORAGE.put.bind(env.R2_STORAGE);
		const spy =
			step === 'manifest write'
				? vi
						.spyOn(env.R2_STORAGE, 'put')
						.mockImplementation(((key: string, ...rest: any[]) =>
							key.startsWith('codes/') ? Promise.reject(new Error('R2 unavailable')) : (original as any)(key, ...rest)) as any)
				: vi.spyOn(env.R2_STORAGE, 'delete').mockRejectedValue(new Error('R2 unavailable'));
		let first: Response;
		try {
			first = await extend(share.sessionId, { validityDays: 7 });
		} finally {
			spy.mockRestore();
		}
		expect(first.status).toBe(500);

		// Session already moved; the chest is refused rather than served with a wrong expiry
		if (step === 'manifest write') expect((await postRetrieve(share.code)).status).toBe(404);

		expect((await extend(share.sessionId, { validityDays: 7 })).status).toBe(200);
		const after = await expiryOf(share);
		expect(after.manifest).toBe(after.session);
		expect((await postRetrieve(share.code)).status).toBe(200);
	});

	it('cleanup repairs a half-finished extension when the old entry comes due, and never deletes the share', async () => {
		const share = await makeShare('a.txt', 1);
		const original = env.R2_STORAGE.put.bind(env.R2_STORAGE);
		const spy = vi
			.spyOn(env.R2_STORAGE, 'put')
			.mockImplementation(((key: string, ...rest: any[]) =>
				key.startsWith('codes/') ? Promise.reject(new Error('R2 unavailable')) : (original as any)(key, ...rest)) as any);
		try {
			await extend(share.sessionId, { validityDays: 7 });
		} finally {
			spy.mockRestore();
		}
		const result = await cleanupExpired(env.R2_STORAGE, now() + 2 * DAY);
		expect(result.expiredChests).toBe(0);
		expect(result.repairedExpiry).toBe(1);
		const after = await expiryOf(share);
		expect(after.manifest).toBe(after.session);
		expect(await indexKeys()).toHaveLength(1);
		expect(await env.R2_STORAGE.head(`sessions/${share.sessionId}`)).not.toBeNull();
	});

	it('cleanup does not delete a share whose old entry is due after it was extended', async () => {
		const share = await makeShare('a.txt', 1);
		await extend(share.sessionId, { validityDays: 7 });
		const oldKey = `expiry/${String(now() + DAY).padStart(10, '0')}/${share.code}`;
		await env.R2_STORAGE.put(oldKey, ''); // an old entry that survived
		const result = await cleanupExpired(env.R2_STORAGE, now() + 2 * DAY);
		expect(result.expiredChests).toBe(0);
		expect((await postRetrieve(share.code)).status).toBe(200);
		expect(await env.R2_STORAGE.head(oldKey)).toBeNull();
	});
});
