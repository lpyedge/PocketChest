import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { resetStorage, setupTestEnvironment, testFetch } from './utils/test-setup';
import worker from '../src/worker/index';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('POST /api/chest - Create Chest', () => {
	beforeAll(async () => {
		await resetStorage();
	});

	beforeEach(async () => {
		await setupTestEnvironment();
	});

	it('should create new chest and return sessionId + uploadToken', async () => {
		const request = new IncomingRequest('http://example.com/api/chest', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({}),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const data = (await response.json()) as any;
		expect(data).toHaveProperty('sessionId');
		expect(data).toHaveProperty('uploadToken');
		expect(data).toHaveProperty('expiresIn', 86400);
		expect(typeof data.sessionId).toBe('string');
		expect(data.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
	});

	it('should handle concurrent requests properly', async () => {
		const requests = Array(3)
			.fill(null)
			.map(
				() =>
					new IncomingRequest('http://example.com/api/chest', {
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
						},
						body: JSON.stringify({}),
					}),
			);

		const responses = await Promise.all(
			requests.map(async (request) => {
				const ctx = createExecutionContext();
				const response = await worker.fetch(request, env, ctx);
				await waitOnExecutionContext(ctx);
				return response.json();
			}),
		);

		const sessionIds = responses.map((r: any) => r.sessionId);
		const uniqueIds = new Set(sessionIds);
		expect(uniqueIds.size).toBe(3); // All should be unique
	});

	it('should open the upload session in storage', async () => {
		const response = await testFetch('http://example.com/api/chest', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({}),
		});

		expect(response.status).toBe(200);
		const data = (await response.json()) as any;

		// The open session is a pending/{createdAt}/{sessionId} marker in R2
		const markers = await env.R2_STORAGE.list({ prefix: 'pending/' });
		expect(markers.objects.map((object) => object.key.split('/')[2])).toEqual([data.sessionId]);
	});

	it('should not include CORS headers in response', async () => {
		const response = await testFetch('http://example.com/api/chest', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({}),
		});

		expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
		expect(response.headers.get('Content-Type')).toBe('application/json');
	});
});
