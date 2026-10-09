/**
 * Upload session record: the single authoritative state for one upload session.
 *
 * Stored at sessions/{sessionId} as JSON. Every state change is a conditional write
 * (If-Match on the ETag read earlier), so two requests cannot both move a session.
 * Other objects (pending/ markers, files, codes/) are indexes or content, never the source of truth.
 */

export type SessionStatus = 'OPEN' | 'FINALIZING' | 'COMPLETED' | 'ABANDONED';

export interface SessionRecord {
	version: 1;
	sessionId: string;
	status: SessionStatus;
	createdAt: number;
	retrievalCode: string | null;
	validityDays: number | null;
	expiresAt: number | null;
	fileIds: string[] | null;
}

export type SessionErrorCode = 'NOT_FOUND' | 'ALREADY_EXISTS' | 'INVALID_TRANSITION' | 'CONFLICT' | 'CORRUPT_RECORD';

export class SessionError extends Error {
	constructor(
		readonly code: SessionErrorCode,
		message: string,
	) {
		super(message);
		this.name = 'SessionError';
	}
}

// The complete state machine. Anything not listed here is rejected.
const TRANSITIONS: Record<SessionStatus, readonly SessionStatus[]> = {
	OPEN: ['FINALIZING', 'ABANDONED'],
	FINALIZING: ['COMPLETED', 'OPEN'], // OPEN again when finalizing is rolled back
	COMPLETED: [],
	ABANDONED: [],
};

const STATUSES: readonly SessionStatus[] = ['OPEN', 'FINALIZING', 'COMPLETED', 'ABANDONED'];
const MAX_ATTEMPTS = 5;

export type SessionPatch = Partial<Pick<SessionRecord, 'retrievalCode' | 'validityDays' | 'expiresAt' | 'fileIds'>>;

export function sessionKey(sessionId: string): string {
	return `sessions/${sessionId}`;
}

// Strict validation: anything unexpected is an error, never a default. Missing fields must not turn into OPEN.
export function parseSessionRecord(value: unknown): SessionRecord {
	const corrupt = (): never => {
		throw new SessionError('CORRUPT_RECORD', 'Session record failed validation');
	};
	if (typeof value !== 'object' || value === null) return corrupt();
	const r = value as Record<string, unknown>;

	const isNullableString = (v: unknown): v is string | null => v === null || (typeof v === 'string' && v.length > 0);
	const isNullableNumber = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isInteger(v));
	const isNullableStringArray = (v: unknown): v is string[] | null =>
		v === null || (Array.isArray(v) && v.every((item) => typeof item === 'string'));

	if (
		r.version !== 1 ||
		typeof r.sessionId !== 'string' ||
		r.sessionId.length === 0 ||
		!STATUSES.includes(r.status as SessionStatus) ||
		typeof r.createdAt !== 'number' ||
		!Number.isInteger(r.createdAt) ||
		!isNullableString(r.retrievalCode) ||
		!isNullableNumber(r.validityDays) ||
		!isNullableNumber(r.expiresAt) ||
		!isNullableStringArray(r.fileIds)
	) {
		return corrupt();
	}

	// A completed session must carry the result it was completed with
	if (r.status === 'COMPLETED' && (r.retrievalCode === null || r.fileIds === null)) {
		return corrupt();
	}

	return {
		version: 1,
		sessionId: r.sessionId,
		status: r.status as SessionStatus,
		createdAt: r.createdAt,
		retrievalCode: r.retrievalCode,
		validityDays: r.validityDays,
		expiresAt: r.expiresAt,
		fileIds: r.fileIds,
	};
}

/** Creates the OPEN record. Fails with ALREADY_EXISTS if the session id is already in use. */
export async function createSessionRecord(bucket: R2Bucket, init: { sessionId: string; createdAt: number }): Promise<SessionRecord> {
	const record: SessionRecord = {
		version: 1,
		sessionId: init.sessionId,
		status: 'OPEN',
		createdAt: init.createdAt,
		retrievalCode: null,
		validityDays: null,
		expiresAt: null,
		fileIds: null,
	};
	const stored = await bucket.put(sessionKey(init.sessionId), JSON.stringify(record), {
		httpMetadata: { contentType: 'application/json' },
		onlyIf: new Headers({ 'If-None-Match': '*' }),
	});
	if (stored === null) {
		throw new SessionError('ALREADY_EXISTS', 'Session already exists');
	}
	return record;
}

/** Reads and validates the record. Returns null if it does not exist. */
export async function getSessionRecord(bucket: R2Bucket, sessionId: string): Promise<{ record: SessionRecord; etag: string } | null> {
	const object = await bucket.get(sessionKey(sessionId));
	if (!object) {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = await object.json();
	} catch {
		throw new SessionError('CORRUPT_RECORD', 'Session record is not valid JSON');
	}
	return { record: parseSessionRecord(parsed), etag: object.etag };
}

/**
 * Moves the session to `to` and applies `patch`, using a conditional write on the ETag that was read.
 * If another request changed the record first, the latest state is read again and the transition
 * is validated against it, so a stale request never overwrites a newer state.
 */
export async function transitionSession(
	bucket: R2Bucket,
	sessionId: string,
	to: SessionStatus,
	patch: SessionPatch = {},
): Promise<SessionRecord> {
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		const current = await getSessionRecord(bucket, sessionId);
		if (!current) {
			throw new SessionError('NOT_FOUND', 'Session not found');
		}

		if (!TRANSITIONS[current.record.status].includes(to)) {
			throw new SessionError('INVALID_TRANSITION', `Cannot move session from ${current.record.status} to ${to}`);
		}

		const next = parseSessionRecord({ ...current.record, ...patch, status: to });
		const stored = await bucket.put(sessionKey(sessionId), JSON.stringify(next), {
			httpMetadata: { contentType: 'application/json' },
			onlyIf: { etagMatches: current.etag },
		});
		if (stored !== null) {
			return next;
		}
		// Lost the race: loop, read the newer record, and validate again
	}
	throw new SessionError('CONFLICT', 'Session changed concurrently; try again');
}
