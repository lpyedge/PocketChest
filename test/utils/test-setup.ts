import { env } from 'cloudflare:test';
import { createOwnerOnce } from '../../src/worker/auth/owner';

// Test environment setup
export const TEST_JWT_SECRET = 'test-jwt-secret-for-vitest-only';
export const TEST_ORIGIN = 'http://example.com';
export const TEST_OWNER_PASSWORD = 'test-owner-password-0123456789';

// Removes every object from the R2 bucket so each test starts from empty storage
export async function resetStorage() {
	let cursor: string | undefined;
	do {
		const page = await env.R2_STORAGE.list({ cursor });
		if (page.objects.length > 0) {
			await env.R2_STORAGE.delete(page.objects.map((object) => object.key));
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
}

export async function setupTestEnvironment() {
	// Set environment variables for each test
	env.JWT_SECRET = TEST_JWT_SECRET;

	await resetStorage();
}

// Wrapper for fetch that ensures proper environment variable handling
// Every test request gets its own client address, so the per-address limits of one test never affect another.
// Tests that exercise limits pass their own address explicitly.
export function randomClientIp(): string {
	const octet = () => Math.floor(Math.random() * 254) + 1;
	return `198.51.${octet()}.${octet()}`;
}

export async function testFetch(url: string, init?: RequestInit): Promise<Response> {
	const { env, createExecutionContext, waitOnExecutionContext } = await import('cloudflare:test');
	const worker = (await import('../../src/worker/index')).default;

	const headers = new Headers(init?.headers);
	if (!headers.has('CF-Connecting-IP')) {
		headers.set('CF-Connecting-IP', randomClientIp());
	}
	const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
	const request = new IncomingRequest(url, { ...init, headers } as RequestInit<IncomingRequestCfProperties>);

	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);

	return response;
}

// Signs the test owner in through the real password endpoint, creating the owner first if the bucket has none
export async function ownerSignIn(): Promise<{ cookie: string; csrfToken: string }> {
	await createOwnerOnce(env.R2_STORAGE, TEST_OWNER_PASSWORD);
	const response = await testFetch(`${TEST_ORIGIN}/api/auth/login/password`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Origin: TEST_ORIGIN },
		body: JSON.stringify({ password: TEST_OWNER_PASSWORD }),
	});
	if (response.status !== 200) {
		throw new Error(`Owner sign-in failed with ${response.status}`);
	}
	const cookie = (response.headers.get('Set-Cookie') ?? '').split(';')[0];
	const { csrfToken } = (await response.json()) as { csrfToken: string };
	return { cookie, csrfToken };
}

// Starts an upload session the way the upload page does: as the signed-in owner, with CSRF
export async function createTestSession() {
	const owner = await ownerSignIn();
	const createResponse = await testFetch(`${TEST_ORIGIN}/api/upload-sessions`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Origin: TEST_ORIGIN,
			Cookie: owner.cookie,
			'X-PocketChest-CSRF': owner.csrfToken,
		},
		body: JSON.stringify({}),
	});
	if (createResponse.status !== 200) {
		throw new Error(`Upload session creation failed with ${createResponse.status}`);
	}

	const createData = (await createResponse.json()) as any;
	return {
		sessionId: createData.sessionId,
		uploadToken: createData.uploadToken,
	};
}

// Retrieval uses POST with the code in the JSON body, so it never appears in a URL
export async function postRetrieve(code: unknown, init: { rawBody?: string } = {}): Promise<Response> {
	return testFetch('http://example.com/api/retrieve', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: init.rawBody ?? JSON.stringify({ code }),
	});
}

// Downloads one file the way the browser does: authorize with the retrieval token, then GET with the file's cookie
export async function fetchDownload(chestToken: string, fileId: string): Promise<Response> {
	const authorized = await testFetch('http://example.com/api/download/authorize', {
		method: 'POST',
		headers: { Authorization: `Bearer ${chestToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ fileId }),
	});
	if (authorized.status !== 200) {
		return authorized;
	}
	const cookie = (authorized.headers.get('Set-Cookie') ?? '').split(';')[0];
	await authorized.text();
	return testFetch(`http://example.com/api/download/${fileId}`, { headers: { Cookie: cookie } });
}
