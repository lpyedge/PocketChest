import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { createTestSession, resetStorage, setupTestEnvironment, testFetch } from './utils/test-setup';
import type { RateLimitBinding } from '../src/worker/types';

const e = env as unknown as Record<string, unknown>;

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
		expect(keys[0]).toBe(`test-instance:part:${upload.fileId}:203.0.113.60`);
	});

	it('R08: also limits all parts from one address together, so many files do not multiply the allowance', async () => {
		const keys: string[] = [];
		const saved = (env as any).PART_TOTAL_LIMITER;
		setBinding('PART_TOTAL_LIMITER', limiter(1, keys));
		try {
			const first = await start();
			const second = await start();

			const ok = await sendPart(first, 1);
			const refused = await sendPart(second, 1);

			expect(ok.status).toBe(200);
			expect(refused.status).toBe(429);
			await ok.text();
			await refused.text();
			expect(keys).toEqual(['test-instance:part-all:203.0.113.60', 'test-instance:part-all:203.0.113.60']);
		} finally {
			setBinding('PART_TOTAL_LIMITER', saved);
		}
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
