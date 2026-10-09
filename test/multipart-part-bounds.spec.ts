import { describe, it, expect, beforeEach } from 'vitest';
import { resetStorage, setupTestEnvironment, createTestSession, testFetch } from './utils/test-setup';

const MiB = 1024 * 1024;

async function start() {
	const { sessionId, uploadToken } = await createTestSession();
	const created = await testFetch(`http://example.com/api/upload-sessions/${sessionId}/multipart/create`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${uploadToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ filename: 'big.bin', mimeType: 'application/octet-stream', fileSize: 30 * MiB }),
	});
	const { fileId, uploadId } = (await created.json()) as { fileId: string; uploadId: string };
	return { sessionId, fileId, token: uploadId };
}

// A body that is sent as a stream, so the request carries no Content-Length
function streamOf(totalBytes: number, chunkBytes: number, counters: { pulled: number; cancelled: boolean }) {
	let sent = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			counters.pulled++;
			const size = Math.min(chunkBytes, totalBytes - sent);
			if (size <= 0) return controller.close();
			controller.enqueue(new Uint8Array(size));
			sent += size;
		},
		cancel() {
			counters.cancelled = true;
		},
	});
}

async function putPart(upload: Awaited<ReturnType<typeof start>>, init: RequestInit, n = 1) {
	return testFetch(`http://example.com/api/upload-sessions/${upload.sessionId}/multipart/${upload.fileId}/parts/${n}`, {
		method: 'PUT',
		...init,
		headers: { Authorization: `Bearer ${upload.token}`, ...(init.headers as Record<string, string>) },
	});
}

describe('R03 a multipart part is bounded while it is read', () => {
	beforeEach(async () => {
		await resetStorage();
		await setupTestEnvironment();
	});

	it('C08: accepts exactly 20 MiB', async () => {
		const upload = await start();
		const response = await putPart(upload, { body: new Uint8Array(20 * MiB) });
		expect(response.status).toBe(200);
		await response.text();
	});

	it('C08: refuses an empty part and a declared length of 20 MiB + 1', async () => {
		const upload = await start();
		const empty = await putPart(upload, { body: new Uint8Array(0) });
		expect(empty.status).toBe(400);
		await empty.text();

		const over = await putPart(upload, { body: new Uint8Array(20 * MiB + 1) });
		expect(over.status).toBe(413);
		await over.text();
	});

	it('C07: refuses 20 MiB + 1 sent as a stream with no Content-Length', async () => {
		const upload = await start();
		const counters = { pulled: 0, cancelled: false };
		const response = await putPart(upload, {
			body: streamOf(20 * MiB + 1, 1 * MiB, counters),
			// @ts-expect-error duplex is required for a streamed request body
			duplex: 'half',
		});
		expect(response.status).toBe(413);
		expect(((await response.json()) as any).code).toBe('PAYLOAD_TOO_LARGE');
	});

	it('stops reading soon after the limit instead of consuming an endless stream', async () => {
		const upload = await start();
		const counters = { pulled: 0, cancelled: false };
		const response = await putPart(upload, {
			body: streamOf(200 * MiB, 1 * MiB, counters),
			// @ts-expect-error duplex is required for a streamed request body
			duplex: 'half',
		});
		expect(response.status).toBe(413);
		await response.text();
		expect(counters.pulled).toBeLessThan(40);
	});

	it('C07: a refused part is not registered, so the upload cannot be completed with it', async () => {
		const upload = await start();
		const refused = await putPart(upload, {
			body: streamOf(20 * MiB + 1, MiB, { pulled: 0, cancelled: false }),
			duplex: 'half',
		} as RequestInit);
		await refused.text();

		const complete = await testFetch(`http://example.com/api/upload-sessions/${upload.sessionId}/multipart/${upload.fileId}/complete`, {
			method: 'POST',
			headers: { Authorization: `Bearer ${upload.token}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ parts: [{ partNumber: 1, etag: 'not-an-etag' }] }),
		});
		expect(complete.status).toBeGreaterThanOrEqual(400);
		await complete.text();
	});

	it('accepts a small streamed part with no Content-Length', async () => {
		const upload = await start();
		const response = await putPart(upload, {
			body: streamOf(1 * MiB, 256 * 1024, { pulled: 0, cancelled: false }),
			duplex: 'half',
		} as RequestInit);
		expect(response.status).toBe(200);
		await response.text();
	});
});
