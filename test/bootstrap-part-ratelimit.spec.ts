import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { createTestSession, resetStorage, setupTestEnvironment, testFetch } from './utils/test-setup';
import type { RateLimitBinding } from '../src/worker/types';

const e = env as unknown as Record<string, unknown>;
const BOOTSTRAP_PASSWORD = 'test-bootstrap-password-0123456789';

// Allows the first `allowed` calls and refuses the rest, recording every key
function limiter(allowed: number, keys: string[] = []): RateLimitBinding {
	let calls = 0;
	return {
		limit: async ({ key }) => {
			keys.push(key);
			return { success: ++calls <= allowed };
		},
	};
}

function setBinding(name: string, value: unknown) {
	Object.defineProperty(env, name, { value, configurable: true, writable: true });
}

function bootstrap(password: string) {
	return testFetch('http://example.com/api/auth/bootstrap', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Origin: 'http://example.com', 'CF-Connecting-IP': '203.0.113.50' },
		body: JSON.stringify({ password }),
	});
}

describe('FIX-06 bootstrap is rate limited', () => {
	const saved = { auth: env.AUTH_LIMITER, enabled: e.BOOTSTRAP_ENABLED, secret: e.ADMIN_BOOTSTRAP_PASSWORD };

	beforeEach(async () => {
		await resetStorage();
		await setupTestEnvironment();
		e.BOOTSTRAP_ENABLED = 'true';
		e.ADMIN_BOOTSTRAP_PASSWORD = BOOTSTRAP_PASSWORD;
	});

	afterEach(() => {
		setBinding('AUTH_LIMITER', saved.auth);
		e.BOOTSTRAP_ENABLED = saved.enabled;
		e.ADMIN_BOOTSTRAP_PASSWORD = saved.secret;
	});

	it('answers 429 once wrong passwords reach the limit, and never reveals the secret', async () => {
		const keys: string[] = [];
		setBinding('AUTH_LIMITER', limiter(3, keys));

		const statuses: number[] = [];
		for (let i = 0; i < 5; i++) {
			const response = await bootstrap(`wrong-password-attempt-${i}`);
			statuses.push(response.status);
			expect(await response.text()).not.toContain(BOOTSTRAP_PASSWORD);
		}

		expect(statuses).toEqual([401, 401, 401, 429, 429]);
		expect(keys[0]).toBe('bootstrap:203.0.113.50');
	});

	it('fails closed when the limiter is missing', async () => {
		setBinding('AUTH_LIMITER', undefined);
		const response = await bootstrap(BOOTSTRAP_PASSWORD);
		expect(response.status).toBe(500);
		await response.text();
	});

	it('refuses to start with a bootstrap password shorter than the owner minimum', async () => {
		e.ADMIN_BOOTSTRAP_PASSWORD = 'short';
		const response = await bootstrap('short');
		expect(response.status).toBe(500);
		expect(((await response.json()) as any).code).toBe('BOOTSTRAP_MISCONFIGURED');
	});

	it('still initialises with the right password', async () => {
		const response = await bootstrap(BOOTSTRAP_PASSWORD);
		expect(response.status).toBe(201);
		await response.text();
	});
});

describe('FIX-06 multipart parts are rate limited', () => {
	const saved = env.PART_LIMITER;
	afterEach(() => setBinding('PART_LIMITER', saved));
	beforeEach(async () => {
		await resetStorage();
		await setupTestEnvironment();
	});

	async function start() {
		const { sessionId, uploadToken } = await createTestSession();
		const created = await testFetch(`http://example.com/api/upload-sessions/${sessionId}/multipart/create`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${uploadToken}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ filename: 'big.bin', mimeType: 'application/octet-stream', fileSize: 10 }),
		});
		const { fileId, uploadId } = (await created.json()) as { fileId: string; uploadId: string };
		return { sessionId, fileId, token: uploadId };
	}

	const sendPart = (s: { sessionId: string; fileId: string; token: string }, n = 1) =>
		testFetch(`http://example.com/api/upload-sessions/${s.sessionId}/multipart/${s.fileId}/parts/${n}`, {
			method: 'PUT',
			headers: { Authorization: `Bearer ${s.token}`, 'CF-Connecting-IP': '203.0.113.60' },
			body: new Uint8Array(10),
		});

	it('answers 429 when the same upload resends parts past the limit, keyed by the upload', async () => {
		const upload = await start();
		const keys: string[] = [];
		setBinding('PART_LIMITER', limiter(2, keys));

		const statuses: number[] = [];
		for (let i = 0; i < 4; i++) {
			const response = await sendPart(upload, 1);
			statuses.push(response.status);
			await response.text();
		}

		expect(statuses).toEqual([200, 200, 429, 429]);
		expect(keys[0]).toBe(`part:${upload.fileId}:203.0.113.60`);
	});

	it('does not limit a normal upload of many parts', async () => {
		const upload = await start();
		for (let n = 1; n <= 30; n++) {
			const response = await sendPart(upload, n);
			expect(response.status).toBe(200);
			await response.text();
		}
	});
});
