/**
 * One-time WebAuthn challenges. A challenge is stored under its hash, bound to what it is for and,
 * where the flow starts inside a signed-in session, to that session. It can be used once: the first
 * verification marks it with a conditional write, and any later attempt finds it used.
 */
import { ApiError } from '../errors';
import type { EncryptedSecret } from './owner';
import { sha256Hex } from './sessions';

export const CHALLENGE_SECONDS = 120;
export const CHALLENGE_PREFIX = 'auth/challenges/';

export type ChallengePurpose = 'register' | 'login' | 'reauth' | 'totp-enroll';

interface ChallengeRecord {
	version: 1;
	purpose: ChallengePurpose;
	sessionHash: string | null;
	expiresAt: number;
	used: boolean;
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
		(record.purpose === 'register' || record.purpose === 'login' || record.purpose === 'reauth' || record.purpose === 'totp-enroll') &&
		(record.sessionHash === null || typeof record.sessionHash === 'string') &&
		typeof record.expiresAt === 'number' &&
		typeof record.used === 'boolean' &&
		(record.payload === null || (typeof record.payload === 'object' && record.payload !== null))
	);
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
	const stored = await bucket.put(key, JSON.stringify({ ...record, used: true }), {
		httpMetadata: { contentType: 'application/json' },
		onlyIf: { etagMatches: object.etag },
	});
	if (stored === null) {
		throw invalidChallenge();
	}
	return { payload: record.payload };
}

/**
 * Deletes challenges that have expired. A challenge that is still valid, used or not, is never removed,
 * so a replay cannot succeed after cleanup.
 */
export async function cleanupChallenges(bucket: R2Bucket, now: number, limit = 500): Promise<number> {
	const page = await bucket.list({ prefix: CHALLENGE_PREFIX, limit });
	let removed = 0;
	for (const object of page.objects) {
		const stored = await bucket.get(object.key);
		let expired = true;
		if (stored) {
			try {
				const parsed: unknown = JSON.parse(await stored.text());
				expired = !isChallengeRecord(parsed) || now >= parsed.expiresAt;
			} catch {
				expired = true;
			}
		}
		if (expired) {
			await bucket.delete(object.key);
			removed++;
		}
	}
	return removed;
}
