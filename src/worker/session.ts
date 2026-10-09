/**
 * Upload session record: the single authoritative state for one upload session.
 *
 * Stored at sessions/{sessionId} as JSON. Every change is a conditional write on the ETag that was
 * read (CAS), so two requests cannot both move the session. Other objects (pending/ markers, file
 * content, codes/) are indexes or content, never the source of truth.
 *
 * Writes take a lease before they start and register the stored file when they finish. Completion
 * only proceeds when no unexpired lease exists, so a file can never appear in a chest while its
 * upload is still running.
 */
import type { ChestFile } from './types';

export type SessionStatus = 'OPEN' | 'FINALIZING' | 'COMPLETED' | 'ABANDONED';

export interface SessionLease {
	id: string;
	expiresAt: number;
}

export interface SessionRecord {
	version: 1;
	sessionId: string;
	status: SessionStatus;
	createdAt: number;
	leases: SessionLease[];
	// Verified (size-checked) files registered by finished uploads
	files: ChestFile[];
	retrievalCode: string | null;
	validityDays: number | null;
	expiresAt: number | null;
	fileIds: string[] | null;
}

export type SessionErrorCode =
	'NOT_FOUND' | 'NOT_OPEN' | 'ALREADY_EXISTS' | 'INVALID_TRANSITION' | 'LEASE_ACTIVE' | 'LEASE_LOST' | 'CONFLICT' | 'CORRUPT_RECORD';

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
	const isLease = (v: unknown): v is SessionLease => {
		const lease = v as Record<string, unknown>;
		return typeof lease?.id === 'string' && typeof lease.expiresAt === 'number' && Number.isInteger(lease.expiresAt);
	};
	const isFile = (v: unknown): v is ChestFile => {
		const file = v as Record<string, unknown>;
		return (
			typeof file?.fileId === 'string' &&
			typeof file.filename === 'string' &&
			typeof file.size === 'number' &&
			typeof file.mimeType === 'string' &&
			typeof file.isText === 'boolean' &&
			(file.fileExtension === null || typeof file.fileExtension === 'string')
		);
	};

	if (
		r.version !== 1 ||
		typeof r.sessionId !== 'string' ||
		r.sessionId.length === 0 ||
		!STATUSES.includes(r.status as SessionStatus) ||
		typeof r.createdAt !== 'number' ||
		!Number.isInteger(r.createdAt) ||
		!Array.isArray(r.leases) ||
		!r.leases.every(isLease) ||
		!Array.isArray(r.files) ||
		!r.files.every(isFile) ||
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
		leases: r.leases as SessionLease[],
		files: r.files as ChestFile[],
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
		leases: [],
		files: [],
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
 * Applies `mutate` to the current record and stores the result with a conditional write on the ETag
 * that was read. If another request changed the record first, the latest state is read again and
 * `mutate` runs against it, so a stale request never overwrites a newer state.
 */
export async function updateSession(
	bucket: R2Bucket,
	sessionId: string,
	mutate: (current: SessionRecord, now: number) => SessionRecord,
	now: number,
): Promise<SessionRecord> {
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		const current = await getSessionRecord(bucket, sessionId);
		if (!current) {
			throw new SessionError('NOT_FOUND', 'Session not found');
		}

		const next = parseSessionRecord(mutate(current.record, now));
		const stored = await bucket.put(sessionKey(sessionId), JSON.stringify(next), {
			httpMetadata: { contentType: 'application/json' },
			onlyIf: { etagMatches: current.etag },
		});
		if (stored !== null) {
			return next;
		}
	}
	throw new SessionError('CONFLICT', 'Session changed concurrently; try again');
}

/** Moves the session along one allowed transition and applies `patch`. */
export function transitionSession(
	bucket: R2Bucket,
	sessionId: string,
	to: SessionStatus,
	patch: SessionPatch = {},
	now: number = Math.floor(Date.now() / 1000),
): Promise<SessionRecord> {
	return updateSession(
		bucket,
		sessionId,
		(current) => {
			if (!TRANSITIONS[current.status].includes(to)) {
				throw new SessionError('INVALID_TRANSITION', `Cannot move session from ${current.status} to ${to}`);
			}
			return { ...current, ...patch, status: to };
		},
		now,
	);
}

/** Reserves a write lease. Only OPEN sessions accept leases. Expired leases are dropped on the way. */
export function acquireLease(
	bucket: R2Bucket,
	sessionId: string,
	lease: SessionLease,
	now: number = Math.floor(Date.now() / 1000),
): Promise<SessionRecord> {
	return updateSession(
		bucket,
		sessionId,
		(current, at) => {
			if (current.status !== 'OPEN') {
				throw new SessionError('NOT_OPEN', 'Session is no longer accepting uploads');
			}
			const live = current.leases.filter((existing) => existing.expiresAt > at);
			return { ...current, leases: [...live, lease] };
		},
		now,
	);
}

/**
 * Ends a write. `files` are the verified files this write produced (empty for a part upload).
 * Fails with LEASE_LOST if the lease expired or was removed, so a late write cannot register its file.
 */
export function releaseLease(
	bucket: R2Bucket,
	sessionId: string,
	leaseId: string,
	files: ChestFile[],
	now: number = Math.floor(Date.now() / 1000),
): Promise<SessionRecord> {
	return updateSession(
		bucket,
		sessionId,
		(current, at) => {
			const held = current.leases.find((lease) => lease.id === leaseId);
			if (!held || held.expiresAt <= at || current.status !== 'OPEN') {
				throw new SessionError('LEASE_LOST', 'Upload lease expired or was closed before the write finished');
			}
			const known = new Set(current.files.map((file) => file.fileId));
			const added = files.filter((file) => !known.has(file.fileId));
			return {
				...current,
				leases: current.leases.filter((lease) => lease.id !== leaseId),
				files: [...current.files, ...added],
			};
		},
		now,
	);
}

/**
 * Starts completion: OPEN -> FINALIZING, but only when no unexpired lease is held.
 * Expired leases are removed here, so their late writes will fail to register.
 */
export function beginFinalize(bucket: R2Bucket, sessionId: string, now: number = Math.floor(Date.now() / 1000)): Promise<SessionRecord> {
	return updateSession(
		bucket,
		sessionId,
		(current, at) => {
			if (current.status !== 'OPEN') {
				throw new SessionError('INVALID_TRANSITION', `Cannot finalize a session in state ${current.status}`);
			}
			if (current.leases.some((lease) => lease.expiresAt > at)) {
				throw new SessionError('LEASE_ACTIVE', 'Uploads are still in progress for this session');
			}
			return { ...current, status: 'FINALIZING', leases: [] };
		},
		now,
	);
}
