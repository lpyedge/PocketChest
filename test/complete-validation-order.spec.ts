import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { getSessionRecord } from '../src/worker/session';
import { resetStorage, setupTestEnvironment, createTestSession, testFetch } from './utils/test-setup';

const bucket = () => env.R2_STORAGE;
const MiB = 1024 * 1024;

const auth = (token: string, json = true) => ({
	Authorization: `Bearer ${token}`,
	...(json ? { 'Content-Type': 'application/json' } : {}),
});
const base = (sessionId: string) => `http://example.com/api/upload-sessions/${sessionId}`;

async function uploadText(sessionId: string, uploadToken: string, name: string): Promise<string> {
	const formData = new FormData();
	formData.append('textItems', JSON.stringify({ content: name, filename: `${name}.txt` }));
	const response = await testFetch(`${base(sessionId)}/files`, { method: 'POST', headers: auth(uploadToken, false), body: formData });
	return ((await response.json()) as any).uploadedFiles[0].fileId;
}

function complete(sessionId: string, uploadToken: string, fileIds: string[], validityDays = 7) {
	return testFetch(`${base(sessionId)}/complete`, {
		method: 'POST',
		headers: auth(uploadToken),
		body: JSON.stringify({ fileIds, validityDays }),
	});
}

async function startMultipart(sessionId: string, uploadToken: string) {
	const created = await testFetch(`${base(sessionId)}/multipart/create`, {
		method: 'POST',
		headers: auth(uploadToken),
		body: JSON.stringify({ filename: 'big.bin', mimeType: 'application/octet-stream', fileSize: 6 * MiB }),
	});
	const { fileId, uploadId } = (await created.json()) as { fileId: string; uploadId: string };
	return { fileId, token: uploadId };
}

const putPart = (sessionId: string, m: { fileId: string; token: string }, n: number, bytes: number) =>
	testFetch(`${base(sessionId)}/multipart/${m.fileId}/parts/${n}`, {
		method: 'PUT',
		headers: auth(m.token, false),
		body: new Uint8Array(bytes),
	});

describe('R10 Complete validates the files before it touches running uploads', () => {
	beforeEach(async () => {
		await resetStorage();
		await setupTestEnvironment();
	});

	it('C10: a Complete with a foreign file id leaves an active multipart upload usable', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const small = await uploadText(sessionId, uploadToken, 'small');
		const big = await startMultipart(sessionId, uploadToken);
		const first = await putPart(sessionId, big, 1, 5 * MiB);
		const part1 = (await first.json()) as { etag: string };

		const bad = await complete(sessionId, uploadToken, [small, crypto.randomUUID()]);
		expect(bad.status).toBe(400);
		expect(((await bad.json()) as any).code).toBe('FILE_NOT_IN_SESSION');

		const record = (await getSessionRecord(bucket(), sessionId))!.record;
		expect(record.status).toBe('OPEN');
		expect(record.completionFingerprint).toBeNull();
		expect(record.multipartUploads.find((entry) => entry.fileId === big.fileId)?.state).toBe('ACTIVE');

		// The upload carries on: another part, completion of the multipart file, then a correct Complete
		const second = await putPart(sessionId, big, 2, 1 * MiB);
		const part2 = (await second.json()) as { etag: string };
		expect(second.status).toBe(200);
		const done = await testFetch(`${base(sessionId)}/multipart/${big.fileId}/complete`, {
			method: 'POST',
			headers: auth(big.token),
			body: JSON.stringify({
				parts: [
					{ partNumber: 1, etag: part1.etag },
					{ partNumber: 2, etag: part2.etag },
				],
			}),
		});
		expect(done.status).toBe(200);
		await done.text();

		const good = await complete(sessionId, uploadToken, [small, big.fileId]);
		expect(good.status).toBe(200);
		expect(((await good.json()) as any).retrievalCode).toMatch(/^[A-Z0-9]{6}$/);
	});

	it('C10: the same holds when the id is a multipart file that has not finished yet', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const small = await uploadText(sessionId, uploadToken, 'small');
		const big = await startMultipart(sessionId, uploadToken);
		await (await putPart(sessionId, big, 1, 5 * MiB)).text();

		const early = await complete(sessionId, uploadToken, [small, big.fileId]);
		expect(early.status).toBe(400);
		await early.text();

		expect((await getSessionRecord(bucket(), sessionId))!.record.multipartUploads[0].state).toBe('ACTIVE');
		expect((await putPart(sessionId, big, 2, 1 * MiB)).status).toBe(200);
	});

	it('an all-empty selection is refused without disturbing running uploads either', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const empty = await testFetch(`${base(sessionId)}/files`, {
			method: 'POST',
			headers: auth(uploadToken, false),
			body: (() => {
				const formData = new FormData();
				formData.append('files', new File([], 'empty.txt'));
				return formData;
			})(),
		});
		const emptyId = ((await empty.json()) as any).uploadedFiles[0].fileId as string;
		const big = await startMultipart(sessionId, uploadToken);
		await (await putPart(sessionId, big, 1, 5 * MiB)).text();

		const response = await complete(sessionId, uploadToken, [emptyId]);

		expect(response.status).toBe(400);
		expect(((await response.json()) as any).code).toBe('EMPTY_CHEST');
		expect((await getSessionRecord(bucket(), sessionId))!.record.multipartUploads.find((e) => e.fileId === big.fileId)?.state).toBe(
			'ACTIVE',
		);
	});

	it('still ends unfinished multipart uploads once a Complete is really going ahead', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const small = await uploadText(sessionId, uploadToken, 'small');
		const abandoned = await startMultipart(sessionId, uploadToken);
		await (await putPart(sessionId, abandoned, 1, 5 * MiB)).text();

		const response = await complete(sessionId, uploadToken, [small]);

		expect(response.status).toBe(200);
		await response.text();
		const late = await putPart(sessionId, abandoned, 2, 1 * MiB);
		expect(late.status).toBeGreaterThanOrEqual(400);
		await late.text();
	});
});

describe('C13 many identical Completes make one chest', () => {
	beforeEach(async () => {
		await resetStorage();
		await setupTestEnvironment();
	});

	it('gives 100 parallel Completes the same code, one claim and one expiry entry', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const a = await uploadText(sessionId, uploadToken, 'a');
		const b = await uploadText(sessionId, uploadToken, 'b');

		const responses = await Promise.all(
			Array.from({ length: 100 }, (_, i) => complete(sessionId, uploadToken, i % 2 ? [a, b] : [b, a], 14)),
		);
		const bodies = await Promise.all(
			responses.map(async (response) => ({ status: response.status, body: (await response.json()) as any })),
		);

		const ok = bodies.filter((entry) => entry.status === 200);
		const codes = new Set(ok.map((entry) => entry.body.retrievalCode));
		const expiries = new Set(ok.map((entry) => entry.body.expiryDate));
		expect(ok.length).toBeGreaterThan(0);
		// Anything that did not succeed was told to try again, never given a different result
		for (const entry of bodies.filter((e) => e.status !== 200)) expect([409, 503]).toContain(entry.status);
		expect(codes.size).toBe(1);
		expect(expiries.size).toBe(1);

		const record = (await getSessionRecord(bucket(), sessionId))!.record;
		expect(record.status).toBe('COMPLETED');
		expect([...codes][0]).toBe(record.retrievalCode);
		expect((await bucket().list({ prefix: 'codes/' })).objects).toHaveLength(1);
		expect((await bucket().list({ prefix: 'expiry/' })).objects).toHaveLength(1);
		expect(Date.parse([...expiries][0]) / 1000).toBe(record.expiresAt);
	});
});
