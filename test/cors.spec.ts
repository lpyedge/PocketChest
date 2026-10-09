import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { resetStorage, setupTestEnvironment, testFetch } from './utils/test-setup';

// The frontend is served from the same Worker, so the API must not grant cross-origin access
describe('Same-origin API', () => {
	beforeAll(async () => {
		await resetStorage();
	});

	beforeEach(async () => {
		await setupTestEnvironment();
	});

	it('should not answer CORS preflight requests', async () => {
		const response = await testFetch('http://example.com/api/upload-sessions', {
			method: 'OPTIONS',
			headers: {
				Origin: 'https://evil.example',
				'Access-Control-Request-Method': 'POST',
			},
		});

		expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
		expect(response.headers.get('Access-Control-Allow-Methods')).toBeNull();
	});

	it.each([
		['POST', 'http://example.com/api/upload-sessions'],
		['GET', 'http://example.com/api/nonexistent'],
		['GET', 'http://example.com/api/auth/methods'],
		['GET', 'http://example.com/api/download/fake-file-id'],
	])('should not include CORS headers on %s %s', async (method, url) => {
		const response = await testFetch(url, {
			method,
			headers: {
				Origin: 'https://evil.example',
				'Content-Type': 'application/json',
				Authorization: 'Bearer fake-token',
			},
			body: method === 'POST' ? JSON.stringify({}) : undefined,
		});

		expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
	});
});
