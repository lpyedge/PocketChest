import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { getSessionRecord } from '../src/worker/session';
import { cleanupExpired } from '../src/worker/storage';
import { resetStorage, setupTestEnvironment, createTestSession, testFetch } from './utils/test-setup';

const bucket = () => env.R2_STORAGE;
const T0 = 1_900_000_000;
const HOUR = 3600;
const MiB = 1024 * 1024;

const at = (hours: number) => vi.setSystemTime((T0 + hours * HOUR) * 1000);
const auth = (token: string, json = true) => ({
	Authorization: `Bearer ${token}`,
	...(json ? { 'Content-Type': 'application/json' } : {}),
});
const base = (sessionId: string) => `http://example.com/api/upload-sessions/${sessionId}`;

async function startMultipart(sessionId: string, uploadToken: string) {
	const created = await testFetch(`${base(sessionId)}/multipart/create`, {
		method: 'POST',
		headers: auth(uploadToken),
		body: JSON.stringify({ filename: 'big.bin', mimeType: 'application/octet-stream', fileSize: 5 * MiB }),
	});
	return created;
}

const putPart = (sessionId: string, m: { fileId: string; token: string }, n: number) =>
	testFetch(`${base(sessionId)}/multipart/${m.fileId}/parts/${n}`, {
		method: 'PUT',
		headers: auth(m.token, false),
		body: new Uint8Array(5 * MiB),
	});

const completeMultipart = (sessionId: string, m: { fileId: string; token: string }, etag: string) =>
	testFetch(`${base(sessionId)}/multipart/${m.fileId}/complete`, {
		method: 'POST',
		headers: auth(m.token),
		body: JSON.stringify({ parts: [{ partNumber: 1, etag }] }),
	});

const completeChest = (sessionId: string, uploadToken: string, fileIds: string[]) =>
	testFetch(`${base(sessionId)}/complete`, {
		method: 'POST',
		headers: auth(uploadToken),
		body: JSON.stringify({ fileIds, validityDays: 7 }),
	});

describe('N2-01 one upload lifetime: 24 hours from the session start, for every token', () => {
	beforeEach(async () => {
		await resetStorage();
		await setupTestEnvironment();
		vi.useFakeTimers({ toFake: ['Date'] });
		at(0);
	});
	afterEach(() => vi.useRealTimers());

	it('T01: a multipart upload started at 23h cannot outlive the session, so nothing is accepted that cannot be finished', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		at(23);
		const created = await startMultipart(sessionId, uploadToken);
		expect(created.status).toBe(200);
		const { fileId, uploadId } = (await created.json()) as { fileId: string; uploadId: string };
		const multipart = { fileId, token: uploadId };

		// Both tokens end at the same moment
		const exp = (token: string) => JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).exp as number;
		expect(exp(multipart.token)).toBe(exp(uploadToken));
		expect(exp(uploadToken)).toBe(T0 + 24 * HOUR);

		// Just before the end everything still works...
		at(23.9);
		const part = await putPart(sessionId, multipart, 1);
		expect(part.status).toBe(200);
		const { etag } = (await part.json()) as { etag: string };
		const finished = await completeMultipart(sessionId, multipart, etag);
		expect(finished.status).toBe(200);
		await finished.text();
		const chest = await completeChest(sessionId, uploadToken, [fileId]);
		expect(chest.status).toBe(200);
		await chest.text();
	});

	for (const hours of [24, 25, 47]) {
		it(`T01: at ${hours}h every upload call is refused alike`, async () => {
			const { sessionId, uploadToken } = await createTestSession();
			at(23);
			const { fileId, uploadId } = (await (await startMultipart(sessionId, uploadToken)).json()) as { fileId: string; uploadId: string };
			const multipart = { fileId, token: uploadId };
			at(hours);

			const results = {
				createPart: (await startMultipart(sessionId, uploadToken)).status,
				putPart: (await putPart(sessionId, multipart, 1)).status,
				completeMultipart: (await completeMultipart(sessionId, multipart, 'x')).status,
				completeChest: (await completeChest(sessionId, uploadToken, [fileId])).status,
				files: (
					await testFetch(`${base(sessionId)}/files`, {
						method: 'POST',
						headers: auth(uploadToken, false),
						body: (() => {
							const form = new FormData();
							form.append('textItems', JSON.stringify({ content: 'x', filename: 'x.txt' }));
							return form;
						})(),
					})
				).status,
			};

			expect(Object.values(results)).toEqual([401, 401, 401, 401, 401]);
		});
	}

	it('T02: the cleanup job leaves the session alone until 48h and then removes it with its multipart upload', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		at(1);
		const { fileId, uploadId } = (await (await startMultipart(sessionId, uploadToken)).json()) as { fileId: string; uploadId: string };
		await (await putPart(sessionId, { fileId, token: uploadId }, 1)).text();

		at(47);
		const early = await cleanupExpired(bucket(), T0 + 47 * HOUR);
		expect(early.abandonedSessions).toBe(0);
		expect((await getSessionRecord(bucket(), sessionId))!.record.status).toBe('OPEN');

		const late = await cleanupExpired(bucket(), T0 + 49 * HOUR);
		expect(late.abandonedSessions).toBe(1);
		expect(await getSessionRecord(bucket(), sessionId)).toBeNull();
		expect((await bucket().list({ prefix: 'pending/' })).objects).toEqual([]);
	});
});
