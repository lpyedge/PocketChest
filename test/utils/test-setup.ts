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
