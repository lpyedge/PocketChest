import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { createSessionRecord, getSessionRecord, beginFinalize } from '../src/worker/session';
import { finalizeChest, getChest } from '../src/worker/storage';
import { getCurrentTimestamp } from '../src/worker/utils';
import { resetStorage, setupTestEnvironment, createTestSession, testFetch } from './utils/test-setup';

const bucket = () => env.R2_STORAGE;

async function uploadTwoTexts(sessionId: string, uploadToken: string): Promise<string[]> {
	const formData = new FormData();
	formData.append('textItems', JSON.stringify({ content: 'one', filename: 'one.txt' }));
	formData.append('textItems', JSON.stringify({ content: 'two', filename: 'two.txt' }));
	const response = await testFetch(`http://example.com/api/chest/${sessionId}/upload`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${uploadToken}` },
		body: formData,
	});
	return ((await response.json()) as any).uploadedFiles.map((f: any) => f.fileId);
}

function complete(sessionId: string, uploadToken: string, fileIds: string[], validityDays = 7) {
	return testFetch(`http://example.com/api/chest/${sessionId}/complete`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${uploadToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ fileIds, validityDays }),
	});
}

// A bucket wrapper that fails the k-th put whose key starts with `prefix`, once
function failingBucket(prefix: string, k: number): R2Bucket {
	let seen = 0;
	return new Proxy(bucket(), {
		get(target, property) {
			if (property === 'put') {
				return (key: string, ...rest: unknown[]) => {
					if (key.startsWith(prefix) && ++seen === k) {
						return Promise.reject(new Error(`injected failure at ${prefix} #${k}`));
					}
					return (target.put as any).call(target, key, ...rest);
				};
			}
			const value = (target as any)[property];
			return typeof value === 'function' ? value.bind(target) : value;
		},
	}) as R2Bucket;
}

describe('completion idempotency', () => {
	beforeEach(async () => {
		await resetStorage();
		await setupTestEnvironment();
	});

	it('returns the same code when a completed session is completed again with the same files, in any order', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const [a, b] = await uploadTwoTexts(sessionId, uploadToken);

		const first = (await (await complete(sessionId, uploadToken, [a, b])).json()) as any;
		const replay = await complete(sessionId, uploadToken, [b, a]);

		expect(replay.status).toBe(200);
		expect(((await replay.json()) as any).retrievalCode).toBe(first.retrievalCode);
	});

	it('refuses a repeated completion with different files or validity with 409, and keeps the original code', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const [a, b] = await uploadTwoTexts(sessionId, uploadToken);
		const first = (await (await complete(sessionId, uploadToken, [a], 7)).json()) as any;

		const otherFiles = await complete(sessionId, uploadToken, [a, b], 7);
		const otherValidity = await complete(sessionId, uploadToken, [a], 1);

		expect(otherFiles.status).toBe(409);
		expect(((await otherFiles.json()) as any).code).toBe('COMPLETION_MISMATCH');
		expect(otherValidity.status).toBe(409);
		expect((await getSessionRecord(bucket(), sessionId))?.record.retrievalCode).toBe(first.retrievalCode);
	});

	it('gives every concurrent identical completion the same code, with exactly one chest stored', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const [a] = await uploadTwoTexts(sessionId, uploadToken);

		const responses = await Promise.all(Array.from({ length: 100 }, () => complete(sessionId, uploadToken, [a])));
		const bodies = (await Promise.all(responses.map((r) => r.json()))) as any[];

		expect(responses.every((r) => r.status === 200)).toBe(true);
		const codes = new Set(bodies.map((b) => b.retrievalCode));
		expect(codes.size).toBe(1);
		const chests = await bucket().list({ prefix: 'codes/' });
		expect(chests.objects.filter((o) => o.key === `codes/${[...codes][0]}`)).toHaveLength(1);
		expect((await getSessionRecord(bucket(), sessionId))?.record.status).toBe('COMPLETED');
	});

	it('leaves no finalizing index behind once a completion succeeds', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const [a] = await uploadTwoTexts(sessionId, uploadToken);
		await complete(sessionId, uploadToken, [a], 7);

		expect((await bucket().list({ prefix: 'finalizing/' })).objects).toEqual([]);
	});

	it('does not store an expiry index for a permanent chest', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const [a] = await uploadTwoTexts(sessionId, uploadToken);
		const response = (await (await complete(sessionId, uploadToken, [a], -1)).json()) as any;

		const expiry = await bucket().list({ prefix: 'expiry/' });
		expect(expiry.objects.some((o) => o.key.endsWith(`/${response.retrievalCode}`))).toBe(false);
	});

	it('does not serve a manifest that the session does not agree with', async () => {
		const sessionId = crypto.randomUUID();
		const now = getCurrentTimestamp();
		await createSessionRecord(bucket(), { sessionId, createdAt: now });
		await bucket().put('codes/ZZZZZZ', JSON.stringify({ version: 1, sessionId, createdAt: now, expiresAt: null, files: [] }));

		expect(await getChest(bucket(), 'ZZZZZZ', now)).toBeNull();
	});

	// Each failure point, followed by a retry of the same completion, must converge on one chest
	const failurePoints = [
		{ name: 'reserve the candidate code', prefix: 'sessions/', k: 1 },
		{ name: 'claim the code', prefix: 'codes/', k: 1 },
		{ name: 'write the expiry index', prefix: 'expiry/', k: 1 },
		{ name: 'mark the session completed', prefix: 'sessions/', k: 2 },
	];
	for (const point of failurePoints) {
		it(`recovers when the write to "${point.name}" fails once`, async () => {
			const sessionId = crypto.randomUUID();
			const now = getCurrentTimestamp();
			await createSessionRecord(bucket(), { sessionId, createdAt: now });
			const file = { fileId: crypto.randomUUID(), filename: 'a.txt', size: 1, mimeType: 'text/plain', isText: true, fileExtension: 'txt' };
			await bucket().put(`${sessionId}/${file.fileId}`, 'a');
			const plan = { createdAt: now, files: [file], expiresAt: now + 7 * 86400, validityDays: 7, fingerprint: `${file.fileId}|7` };
			await beginFinalize(bucket(), sessionId, plan.fingerprint, now);

			await expect(finalizeChest(failingBucket(point.prefix, point.k), sessionId, plan)).rejects.toThrow('injected failure');

			const code = await finalizeChest(bucket(), sessionId, plan);
			expect(code).toMatch(/^[A-Z0-9]{6}$/);
			expect((await getSessionRecord(bucket(), sessionId))?.record).toMatchObject({ status: 'COMPLETED', retrievalCode: code });
			expect(await getChest(bucket(), code!, now)).not.toBeNull();
			const claims = await bucket().list({ prefix: 'codes/' });
			expect(claims.objects.filter((o) => o.key === `codes/${code}`)).toHaveLength(1);
		});
	}
});
