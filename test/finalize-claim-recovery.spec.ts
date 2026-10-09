import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { beginFinalize, createSessionRecord, getSessionRecord, reserveCandidateCode } from '../src/worker/session';
import { cleanupExpired, getChest } from '../src/worker/storage';
import { getCurrentTimestamp } from '../src/worker/utils';
import { resetStorage, setupTestEnvironment } from './utils/test-setup';

const bucket = () => env.R2_STORAGE;
const HOUR = 3600;
const pad = (n: number) => String(n).padStart(10, '0');

async function keys(prefix: string): Promise<string[]> {
	return (await bucket().list({ prefix })).objects.map((o) => o.key);
}

// A session stuck in FINALIZING, with whichever of claim / expiry index the test asks for
async function stuckFinalizing(opts: {
	code?: string;
	expiresAt: number | null;
	claim?: boolean;
	claimExpiresAt?: number | null;
	indexExpiry?: boolean;
}) {
	const now = getCurrentTimestamp();
	const sessionId = crypto.randomUUID();
	const fileId = crypto.randomUUID();
	const file = { fileId, filename: 'a.txt', size: 1, mimeType: 'text/plain', isText: true, fileExtension: 'txt' };
	const startedAt = now - 2 * HOUR;
	await createSessionRecord(bucket(), { sessionId, createdAt: now - 3 * HOUR });
	await bucket().put(`${sessionId}/${fileId}`, 'a');
	await bucket().put(`pending/${pad(now - 3 * HOUR)}/${sessionId}`, '');
	const raw = (await getSessionRecord(bucket(), sessionId))!.record;
	await bucket().put(`sessions/${sessionId}`, JSON.stringify({ ...raw, files: [file] }));
	await beginFinalize(bucket(), sessionId, `${fileId}|7`, startedAt, {
		validityDays: opts.expiresAt === null ? -1 : 7,
		expiresAt: opts.expiresAt,
	});
	await bucket().put(`finalizing/${pad(startedAt)}/${sessionId}`, '');
	const code = opts.code ?? 'ABC123';
	await reserveCandidateCode(bucket(), sessionId, code);
	if (opts.claim) {
		const claimExpiry = opts.claimExpiresAt === undefined ? opts.expiresAt : opts.claimExpiresAt;
		await bucket().put(
			`codes/${code}`,
			JSON.stringify({ version: 1, sessionId, createdAt: now - 3 * HOUR, expiresAt: claimExpiry, files: [file] }),
		);
		if (claimExpiry !== null && opts.indexExpiry !== false) await bucket().put(`expiry/${pad(claimExpiry)}/${code}`, '');
	}
	return { now, sessionId, fileId, code };
}

describe('FIX-02 stuck completions leave no orphan claims', () => {
	beforeEach(async () => {
		await resetStorage();
		await setupTestEnvironment();
	});

	it('finishes a stuck completion whose code was already claimed, instead of dropping the code', async () => {
		const expiresAt = getCurrentTimestamp() + 7 * 86400;
		const { now, sessionId, fileId, code } = await stuckFinalizing({ expiresAt, claim: true });

		await cleanupExpired(bucket(), now);

		const record = (await getSessionRecord(bucket(), sessionId))!.record;
		expect(record).toMatchObject({ status: 'COMPLETED', retrievalCode: code, expiresAt, fileIds: [fileId] });
		expect(await getChest(bucket(), code, now)).not.toBeNull();
		expect(await keys('finalizing/')).toEqual([]);
		expect(await keys('pending/')).toEqual([]);
		expect(await keys('expiry/')).toEqual([`expiry/${pad(expiresAt)}/${code}`]);
	});

	it('writes the missing expiry index when it finishes a stuck completion', async () => {
		const expiresAt = getCurrentTimestamp() + 7 * 86400;
		const { now, code } = await stuckFinalizing({ expiresAt, claim: true, indexExpiry: false });

		await cleanupExpired(bucket(), now);

		expect(await keys('expiry/')).toEqual([`expiry/${pad(expiresAt)}/${code}`]);
	});

	it('finishes a permanent stuck completion without an expiry index', async () => {
		const { now, sessionId, code } = await stuckFinalizing({ expiresAt: null, claim: true });

		await cleanupExpired(bucket(), now);

		expect((await getSessionRecord(bucket(), sessionId))!.record).toMatchObject({ status: 'COMPLETED', retrievalCode: code });
		expect(await keys('expiry/')).toEqual([]);
	});

	it('rolls back to OPEN when no code was claimed yet', async () => {
		const { now, sessionId } = await stuckFinalizing({ expiresAt: getCurrentTimestamp() + 86400, claim: false });

		const result = await cleanupExpired(bucket(), now);

		expect(result.rolledBackFinalizations).toBe(1);
		expect((await getSessionRecord(bucket(), sessionId))!.record).toMatchObject({ status: 'OPEN', candidateCode: null });
		expect(await keys('codes/')).toEqual([]);
	});

	it('removes a claim and its expiry entry when the claim does not match the stored plan', async () => {
		const expiresAt = getCurrentTimestamp() + 86400;
		const { now, sessionId, code } = await stuckFinalizing({ expiresAt, claim: true, claimExpiresAt: expiresAt - 1800 });

		await cleanupExpired(bucket(), now);

		expect((await getSessionRecord(bucket(), sessionId))!.record.status).toBe('OPEN');
		expect(await keys('codes/')).toEqual([]);
		expect(await keys('expiry/')).toEqual([]);
		expect(code).toBe('ABC123');
	});

	it('removes claims that no session owns, with their expiry entries, and keeps live chests', async () => {
		const now = getCurrentTimestamp();
		const openSession = crypto.randomUUID();
		await createSessionRecord(bucket(), { sessionId: openSession, createdAt: now });
		const expiresAt = now + 86400;
		const manifest = (sessionId: string, at: number | null) =>
			JSON.stringify({ version: 1, sessionId, createdAt: now, expiresAt: at, files: [] });
		await bucket().put('codes/OPEN01', manifest(openSession, expiresAt));
		await bucket().put(`expiry/${pad(expiresAt)}/OPEN01`, '');
		await bucket().put('codes/GONE01', manifest(crypto.randomUUID(), null));

		// A live chest completed through the normal path
		const live = await stuckFinalizing({ code: 'LIVE01', expiresAt: now + 86400, claim: true });
		await cleanupExpired(bucket(), live.now);
		const second = await cleanupExpired(bucket(), live.now);

		expect(await keys('codes/')).toEqual(['codes/LIVE01']);
		expect(await keys('expiry/')).toEqual([`expiry/${pad(live.now + 86400)}/LIVE01`]);
		expect(second.errors).toEqual([]);
	});
});
