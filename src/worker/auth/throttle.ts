/**
 * Owner-level lockout for each sign-in method. The counters belong to the owner, not to a client
 * address, so changing IP does not reset them. Password and authenticator code count separately:
 * a locked password does not block the authenticator, and the reverse.
 */
import { ApiError } from '../errors';

export type ThrottledMethod = 'password' | 'totp';

export const FAILURE_LIMIT = 5;
export const FAILURE_WINDOW_SECONDS = 5 * 60;
const BASE_COOLDOWN_SECONDS = 60;
const MAX_COOLDOWN_SECONDS = 15 * 60;
// After this long without any failure, the repeat-offender count starts again
const MEMORY_SECONDS = 24 * 60 * 60;
const ATTEMPTS = 20;

export interface ThrottleRecord {
	version: 1;
	windowStart: number | null;
	failureCount: number;
	blockedUntil: number | null;
	strikes: number;
	lastActivityAt: number;
}

const METHODS: ThrottledMethod[] = ['password', 'totp'];

export function throttleKey(method: ThrottledMethod): string {
	return `auth/throttle/${method}.json`;
}

function emptyRecord(now: number): ThrottleRecord {
	return { version: 1, windowStart: null, failureCount: 0, blockedUntil: null, strikes: 0, lastActivityAt: now };
}

function isNullableNumber(value: unknown): value is number | null {
	return value === null || (typeof value === 'number' && Number.isFinite(value));
}

// Fails closed: a record that cannot be read is an error, never a fresh start
function parseRecord(text: string): ThrottleRecord {
	const parsed = JSON.parse(text) as Partial<ThrottleRecord>;
	if (
		parsed.version !== 1 ||
		!isNullableNumber(parsed.windowStart) ||
		!isNullableNumber(parsed.blockedUntil) ||
		typeof parsed.failureCount !== 'number' ||
		typeof parsed.strikes !== 'number' ||
		typeof parsed.lastActivityAt !== 'number'
	) {
		throw new Error('Corrupt throttle record');
	}
	return parsed as ThrottleRecord;
}

async function readRecord(bucket: R2Bucket, method: ThrottledMethod): Promise<ThrottleRecord> {
	const object = await bucket.get(throttleKey(method));
	return object ? parseRecord(await object.text()) : emptyRecord(0);
}

// Applies `mutate` with a conditional write, so a concurrent failure is never lost
async function updateRecord(
	bucket: R2Bucket,
	method: ThrottledMethod,
	now: number,
	mutate: (current: ThrottleRecord) => ThrottleRecord,
): Promise<ThrottleRecord> {
	const key = throttleKey(method);
	for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
		if (attempt > 0) {
			await new Promise((resolve) => setTimeout(resolve, Math.random() * 10 * attempt));
		}
		const object = await bucket.get(key);
		const current = object ? parseRecord(await object.text()) : emptyRecord(now);
		const next = mutate(current);
		const stored = await bucket.put(key, JSON.stringify(next), {
			httpMetadata: { contentType: 'application/json' },
			onlyIf: object ? { etagMatches: object.etag } : new Headers({ 'If-None-Match': '*' }),
		});
		if (stored !== null) {
			return next;
		}
	}
	throw new ApiError(409, 'CONFLICT', 'Sign-in is busy, try again');
}

/** Refuses the attempt, before any password or code is checked, while the method is locked. */
export async function assertNotLocked(bucket: R2Bucket, method: ThrottledMethod, now: number): Promise<void> {
	const record = await readRecord(bucket, method);
	if (record.blockedUntil !== null && record.blockedUntil > now) {
		throw new ApiError(429, 'AUTH_TEMPORARILY_LOCKED', 'Too many failed attempts; try again later', {
			'Retry-After': String(record.blockedUntil - now),
		});
	}
}

export async function recordFailure(bucket: R2Bucket, method: ThrottledMethod, now: number): Promise<void> {
	await updateRecord(bucket, method, now, (record) => {
		// A lock already in effect absorbs the failure without changing the lock
		if (record.blockedUntil !== null && record.blockedUntil > now) {
			return record;
		}
		const inWindow = record.windowStart !== null && now - record.windowStart < FAILURE_WINDOW_SECONDS;
		const failureCount = (inWindow ? record.failureCount : 0) + 1;
		if (failureCount < FAILURE_LIMIT) {
			return { ...record, windowStart: inWindow ? record.windowStart : now, failureCount, lastActivityAt: now };
		}

		const remembered = now - record.lastActivityAt < MEMORY_SECONDS ? record.strikes : 0;
		const strikes = remembered + 1;
		const cooldown = Math.min(BASE_COOLDOWN_SECONDS * 2 ** (strikes - 1), MAX_COOLDOWN_SECONDS);
		return {
			version: 1,
			windowStart: null,
			failureCount: 0,
			blockedUntil: now + cooldown,
			strikes,
			lastActivityAt: now,
		};
	});
}

/** A success clears this method's failures and repeat count. A lock that is still running is kept. */
export async function clearFailures(bucket: R2Bucket, method: ThrottledMethod, now: number): Promise<void> {
	await updateRecord(bucket, method, now, (record) => {
		const stillLocked = record.blockedUntil !== null && record.blockedUntil > now;
		return { ...emptyRecord(now), blockedUntil: stillLocked ? record.blockedUntil : null };
	});
}

/**
 * Resets records that have been quiet for a long time and are not locked. Only two records exist, so
 * this is a reset in place rather than a delete: a failure that lands meanwhile is never lost.
 */
export async function cleanupThrottles(bucket: R2Bucket, now: number): Promise<number> {
	let reset = 0;
	for (const method of METHODS) {
		const before = await readRecord(bucket, method);
		const quiet = now - before.lastActivityAt >= MEMORY_SECONDS;
		const locked = before.blockedUntil !== null && before.blockedUntil > now;
		if (!quiet || locked || (before.failureCount === 0 && before.strikes === 0 && before.blockedUntil === null)) {
			continue;
		}
		await updateRecord(bucket, method, now, (current) => {
			const stillQuiet = now - current.lastActivityAt >= MEMORY_SECONDS;
			const stillLocked = current.blockedUntil !== null && current.blockedUntil > now;
			return stillQuiet && !stillLocked ? emptyRecord(now) : current;
		});
		reset++;
	}
	return reset;
}
