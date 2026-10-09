/**
 * One-time WebAuthn challenges. A challenge is stored under its hash, bound to what it is for and,
 * where the flow starts inside a signed-in session, to that session. It can be used once: the first
 * verification marks it with a conditional write, and any later attempt finds it used.
 */
import { ApiError } from '../errors';
import type { EncryptedSecret } from './owner';
import { sha256Hex } from './sessions';
import { scanBatch, ScanState } from './scan';

export const CHALLENGE_SECONDS = 120;
export const CHALLENGE_PREFIX = 'auth/challenges/';

export type ChallengePurpose = 'register' | 'login' | 'reauth' | 'activate' | 'totp-enroll';

interface ChallengeRecord {
	version: 1;
	purpose: ChallengePurpose;
	sessionHash: string | null;
	expiresAt: number;
	used: boolean;
	// Wrong answers so far, for challenges that allow a few tries (see failChallenge)
	failures?: number;
	// Sealed data a later step needs, such as a TOTP seed being enrolled
	payload: EncryptedSecret | null;
}

export function challengeKey(hash: string): string {
	return `${CHALLENGE_PREFIX}${hash}`;
}

export async function storeChallenge(
	bucket: R2Bucket,
	challenge: string,
	purpose: ChallengePurpose,
	sessionHash: string | null,
	now: number,
	options: { ttlSeconds?: number; payload?: EncryptedSecret } = {},
): Promise<void> {
	const record: ChallengeRecord = {
		version: 1,
		purpose,
		sessionHash,
		expiresAt: now + (options.ttlSeconds ?? CHALLENGE_SECONDS),
		used: false,
		payload: options.payload ?? null,
	};
	await bucket.put(challengeKey(await sha256Hex(challenge)), JSON.stringify(record), {
		httpMetadata: { contentType: 'application/json' },
		onlyIf: new Headers({ 'If-None-Match': '*' }),
	});
}

function invalidChallenge(): ApiError {
	return new ApiError(400, 'CHALLENGE_INVALID', 'The sign-in step expired or was already used; start again');
}

function isChallengeRecord(value: unknown): value is ChallengeRecord {
	const record = value as Partial<ChallengeRecord>;
	return (
		typeof record === 'object' &&
		record !== null &&
		record.version === 1 &&
		(record.purpose === 'register' ||
			record.purpose === 'login' ||
			record.purpose === 'reauth' ||
			record.purpose === 'activate' ||
			record.purpose === 'totp-enroll') &&
		(record.sessionHash === null || typeof record.sessionHash === 'string') &&
		typeof record.expiresAt === 'number' &&
		typeof record.used === 'boolean' &&
		(record.failures === undefined || (typeof record.failures === 'number' && Number.isInteger(record.failures))) &&
		(record.payload === null || (typeof record.payload === 'object' && record.payload !== null))
	);
}

interface OpenChallenge {
	key: string;
	record: ChallengeRecord;
	etag: string;
}

/** Reads a challenge and checks it is for this purpose and session, unused and not expired. Does not use it up. */
async function openChallenge(
	bucket: R2Bucket,
	challenge: string,
	purpose: ChallengePurpose,
	sessionHash: string | null,
	now: number,
): Promise<OpenChallenge> {
	if (!/^[A-Za-z0-9_-]{32,128}$/.test(challenge)) {
		throw invalidChallenge();
	}
	const key = challengeKey(await sha256Hex(challenge));
	const object = await bucket.get(key);
	if (!object) {
		throw invalidChallenge();
	}
	let record: unknown;
	try {
		record = JSON.parse(await object.text());
	} catch {
		throw invalidChallenge();
	}
	if (!isChallengeRecord(record) || record.used || record.purpose !== purpose || record.sessionHash !== sessionHash) {
		throw invalidChallenge();
	}
	if (now >= record.expiresAt) {
		throw invalidChallenge();
	}
	return { key, record, etag: object.etag };
}

const CHALLENGE_WRITE_ATTEMPTS = 20;

/**
 * Marks an opened challenge used with a conditional write. If the record changed since it was read (for
 * example another wrong answer was counted), it is read again; a challenge that is by then used or expired
 * is refused. A second caller racing for the same challenge loses and is refused.
 */
async function useOpened(bucket: R2Bucket, opened: OpenChallenge, now: number): Promise<void> {
	let { record, etag } = opened;
	for (let attempt = 0; attempt < CHALLENGE_WRITE_ATTEMPTS; attempt++) {
		const stored = await bucket.put(opened.key, JSON.stringify({ ...record, used: true }), {
			httpMetadata: { contentType: 'application/json' },
			onlyIf: { etagMatches: etag },
		});
		if (stored !== null) return;
		const object = await bucket.get(opened.key);
		const latest: unknown = object ? JSON.parse(await object.text()) : null;
		if (!object || !isChallengeRecord(latest) || latest.used || now >= latest.expiresAt) {
			throw invalidChallenge();
		}
		record = latest;
		etag = object.etag;
	}
	throw invalidChallenge();
}

/**
 * Marks the challenge used, if it is for this purpose, this session and not expired. A second caller
 * racing for the same challenge loses the conditional write and is refused.
 */
export async function consumeChallenge(
	bucket: R2Bucket,
	challenge: string,
	purpose: ChallengePurpose,
	sessionHash: string | null,
	now: number,
): Promise<{ payload: EncryptedSecret | null }> {
	const opened = await openChallenge(bucket, challenge, purpose, sessionHash, now);
	await useOpened(bucket, opened, now);
	return { payload: opened.record.payload };
}

/**
 * For a challenge that allows a few wrong answers: checks the challenge without using it up, and hands back
 * `fail()` (count one wrong answer) and `succeed()` (use it up). The challenge is ended for good once
 * `maxFailures` wrong answers have been counted, so the code behind it cannot be guessed at without limit.
 */
export async function beginAttempts(
	bucket: R2Bucket,
	challenge: string,
	purpose: ChallengePurpose,
	sessionHash: string | null,
	now: number,
	maxFailures: number,
): Promise<{ payload: EncryptedSecret | null; fail: () => Promise<{ ended: boolean }>; succeed: () => Promise<void> }> {
	const opened = await openChallenge(bucket, challenge, purpose, sessionHash, now);
	return {
		payload: opened.record.payload,
		succeed: () => useOpened(bucket, opened, now),
		fail: async () => {
			let { record, etag } = opened;
			for (let attempt = 0; attempt < CHALLENGE_WRITE_ATTEMPTS; attempt++) {
				const failures = (record.failures ?? 0) + 1;
				const ended = failures >= maxFailures;
				const stored = await bucket.put(opened.key, JSON.stringify({ ...record, failures, used: ended }), {
					httpMetadata: { contentType: 'application/json' },
					onlyIf: { etagMatches: etag },
				});
				if (stored !== null) return { ended };
				const object = await bucket.get(opened.key);
				const latest: unknown = object ? JSON.parse(await object.text()) : null;
				if (!object || !isChallengeRecord(latest) || latest.used || now >= latest.expiresAt) {
					return { ended: true };
				}
				record = latest;
				etag = object.etag;
			}
			// Could not count it: treat the challenge as spent rather than let a guess go uncounted
			await bucket.put(opened.key, JSON.stringify({ ...record, used: true })).catch(() => undefined);
			return { ended: true };
		},
	};
}

/**
 * Deletes challenges that have expired. A challenge that is still valid, used or not, is never removed,
 * so a replay cannot succeed after cleanup.
 */
export async function cleanupChallenges(bucket: R2Bucket, now: number, limit = 500, state?: ScanState): Promise<number> {
	return scanBatch(bucket, CHALLENGE_PREFIX, limit, state, async (key) => {
		const stored = await bucket.get(key);
		let expired = true;
		if (stored) {
			try {
				const parsed: unknown = JSON.parse(await stored.text());
				expired = !isChallengeRecord(parsed) || now >= parsed.expiresAt;
			} catch {
				expired = true;
			}
		}
		if (expired) await bucket.delete(key);
		return expired;
	});
}
