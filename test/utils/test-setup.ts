import { env } from 'cloudflare:test';
import { generateTOTPSecret } from '../../src/worker/utils';

// Test environment setup
export const TEST_JWT_SECRET = 'test-jwt-secret-for-vitest-only';
export const TEST_TOTP_SECRET = generateTOTPSecret();
export const TEST_TOTP_SECRETS = `test:${TEST_TOTP_SECRET}`;

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
	env.TOTP_SECRETS = TEST_TOTP_SECRETS;
	env.REQUIRE_TOTP = 'false'; // Disable TOTP for most tests unless specifically testing it

	await resetStorage();
}

// Wrapper for fetch that ensures proper environment variable handling
export async function testFetch(url: string, init?: RequestInit): Promise<Response> {
	const { env, createExecutionContext, waitOnExecutionContext } = await import('cloudflare:test');
	const worker = (await import('../../src/worker/index')).default;

	const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
	const request = new IncomingRequest(url, init as RequestInit<IncomingRequestCfProperties>);

	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);

	return response;
}

export async function createTestSession() {
	const createResponse = await testFetch('http://example.com/api/chest', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({}),
	});

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
