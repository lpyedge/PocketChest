import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { ownerSignIn, resetStorage, setupTestEnvironment, testFetch, TEST_ORIGIN } from './utils/test-setup';

const CREATE_URL = `${TEST_ORIGIN}/api/upload-sessions`;

function createSession(headers: Record<string, string>) {
	return testFetch(CREATE_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...headers },
		body: JSON.stringify({}),
	});
}

async function openSessionIds(): Promise<string[]> {
	const markers = await env.R2_STORAGE.list({ prefix: 'pending/' });
	return markers.objects.map((object) => object.key.split('/')[2]);
}

describe('POST /api/upload-sessions', () => {
	beforeAll(async () => {
		await resetStorage();
	});

	beforeEach(async () => {
		await setupTestEnvironment();
	});

	it('creates a session for the signed-in owner and returns sessionId + uploadToken', async () => {
		const owner = await ownerSignIn();
		const response = await createSession({ Origin: TEST_ORIGIN, Cookie: owner.cookie, 'X-PocketChest-CSRF': owner.csrfToken });

		expect(response.status).toBe(200);
		const data = (await response.json()) as any;
		expect(data).toHaveProperty('uploadToken');
		expect(data).toHaveProperty('expiresIn', 86400);
		expect(data.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
	});

	it('gives every concurrent request its own session', async () => {
		const owner = await ownerSignIn();
		const headers = { Origin: TEST_ORIGIN, Cookie: owner.cookie, 'X-PocketChest-CSRF': owner.csrfToken };
		const responses = await Promise.all([createSession(headers), createSession(headers), createSession(headers)]);
		const ids = await Promise.all(responses.map(async (response) => ((await response.json()) as any).sessionId));

		expect(new Set(ids).size).toBe(3);
	});

	it('opens the session in storage', async () => {
		const owner = await ownerSignIn();
		const response = await createSession({ Origin: TEST_ORIGIN, Cookie: owner.cookie, 'X-PocketChest-CSRF': owner.csrfToken });
		const data = (await response.json()) as any;

		expect(await openSessionIds()).toEqual([data.sessionId]);
	});

	it('does not send CORS headers', async () => {
		const owner = await ownerSignIn();
		const response = await createSession({ Origin: TEST_ORIGIN, Cookie: owner.cookie, 'X-PocketChest-CSRF': owner.csrfToken });

		expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
		expect(response.headers.get('Content-Type')).toBe('application/json');
		await response.text();
	});

	it('refuses anonymous callers and opens nothing', async () => {
		await ownerSignIn();
		const response = await createSession({ Origin: TEST_ORIGIN });

		expect(response.status).toBe(401);
		await response.text();
		expect(await openSessionIds()).toEqual([]);
	});

	it('refuses a forged session cookie', async () => {
		await ownerSignIn();
		const response = await createSession({ Origin: TEST_ORIGIN, Cookie: '__Host-pc_owner=forged-session-id' });

		expect(response.status).toBe(401);
		await response.text();
		expect(await openSessionIds()).toEqual([]);
	});

	it('refuses a signed-in request without the CSRF header', async () => {
		const owner = await ownerSignIn();
		const response = await createSession({ Origin: TEST_ORIGIN, Cookie: owner.cookie });

		expect(response.status).toBe(403);
		await response.text();
		expect(await openSessionIds()).toEqual([]);
	});

	it('refuses a signed-in request from another origin', async () => {
		const owner = await ownerSignIn();
		const response = await createSession({ Origin: 'https://evil.example', Cookie: owner.cookie, 'X-PocketChest-CSRF': owner.csrfToken });

		expect(response.status).toBe(403);
		await response.text();
		expect(await openSessionIds()).toEqual([]);
	});

	it('keeps upload tokens and owner sessions apart', async () => {
		const owner = await ownerSignIn();
		const created = (await (
			await createSession({ Origin: TEST_ORIGIN, Cookie: owner.cookie, 'X-PocketChest-CSRF': owner.csrfToken })
		).json()) as any;

		// An upload token is not an owner session, so it cannot start another session
		const asOwner = await createSession({ Origin: TEST_ORIGIN, Authorization: `Bearer ${created.uploadToken}` });
		expect(asOwner.status).toBe(401);
		await asOwner.text();
	});

	it('limits an upload token to its own session', async () => {
		const owner = await ownerSignIn();
		const headers = { Origin: TEST_ORIGIN, Cookie: owner.cookie, 'X-PocketChest-CSRF': owner.csrfToken };
		const first = (await (await createSession(headers)).json()) as any;
		const second = (await (await createSession(headers)).json()) as any;

		const formData = new FormData();
		formData.append('textItems', JSON.stringify({ content: 'cross', filename: 'cross.txt' }));
		const response = await testFetch(`${TEST_ORIGIN}/api/upload-sessions/${second.sessionId}/files`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${first.uploadToken}` },
			body: formData,
		});
		expect(response.status).toBe(400);
		await response.text();
	});

	it('no longer exists at the old /api/chest path', async () => {
		const response = await testFetch(`${TEST_ORIGIN}/api/chest`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Origin: TEST_ORIGIN },
			body: JSON.stringify({}),
		});

		expect(response.status).toBe(404);
		await response.text();
	});
});
