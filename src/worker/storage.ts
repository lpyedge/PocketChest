import { cleanupOwnerSessions } from './auth/sessions';
import { cleanupThrottles } from './auth/throttle';
import { cleanupChallenges } from './auth/challenges';
import type { ScanState } from './auth/scan';
import { ChestFile, ChestManifest } from './types';
import {
	createSessionRecord,
	getSessionRecord,
	MultipartUploadEntry,
	SessionRecord,
	replaceCandidateCode,
	reserveCandidateCode,
	sessionKey,
	SessionError,
	transitionSession,
} from './session';
import { generateRetrievalCode } from './utils';

/**
 * All state lives in R2; there is no database. Key layout:
 *
 *   {sessionId}/{fileId}              file content, with filename/isText in customMetadata
 *   pending/{createdAt}/{sessionId}   marker for an open upload session, removed on completion
 *   codes/{CODE}                      chest manifest (JSON), the source of truth for retrieval
 *   expiry/{expiresAt}/{CODE}         expiry index entry for chests that are not permanent
 *
 * Timestamps are zero-padded Unix seconds, so R2's lexicographic list order is chronological
 * and the cleanup job can stop listing at the first entry that is not yet due.
 */

// Upload sessions that are never completed are removed after this long (matches the multipart JWT)
export const ABANDONED_SESSION_SECONDS = 48 * 60 * 60;

// Upper bound on chests/sessions removed per cleanup run; the rest are picked up by the next run
const CLEANUP_BATCH_LIMIT = 200;

const R2_DELETE_BATCH = 1000;

function timestampSegment(timestamp: number): string {
	return String(timestamp).padStart(10, '0');
}

export function fileKey(sessionId: string, fileId: string): string {
	return `${sessionId}/${fileId}`;
}

function pendingKey(createdAt: number, sessionId: string): string {
	return `pending/${timestampSegment(createdAt)}/${sessionId}`;
}

function codeKey(code: string): string {
	return `codes/${code}`;
}

function expiryKey(expiresAt: number, code: string): string {
	return `expiry/${timestampSegment(expiresAt)}/${code}`;
}

// --- Upload sessions ---

// The session record is authoritative; the pending/ marker only lets the cleanup job find the session
export async function openSession(bucket: R2Bucket, sessionId: string, createdAt: number): Promise<void> {
	await createSessionRecord(bucket, { sessionId, createdAt });
	await bucket.put(pendingKey(createdAt, sessionId), '');
}

export async function isSessionOpen(bucket: R2Bucket, sessionId: string): Promise<boolean> {
	try {
		return (await getSessionRecord(bucket, sessionId))?.record.status === 'OPEN';
	} catch (error) {
		if (error instanceof SessionError && error.code === 'CORRUPT_RECORD') {
			return false;
		}
		throw error;
	}
}

async function closeSession(bucket: R2Bucket, sessionId: string, createdAt: number): Promise<void> {
	await bucket.delete(pendingKey(createdAt, sessionId));
}

// --- Files ---

export interface FileMetadata {
	filename: string;
	mimeType: string;
	isText: boolean;
}

export function fileUploadOptions(meta: FileMetadata): R2PutOptions & R2MultipartOptions {
	return {
		httpMetadata: { contentType: meta.mimeType },
		customMetadata: {
			filename: encodeURIComponent(meta.filename),
			isText: meta.isText ? '1' : '0',
		},
	};
}

function getFileExtension(filename: string): string | null {
	const lastDot = filename.lastIndexOf('.');
	return lastDot > 0 ? filename.substring(lastDot + 1) : null;
}

export class StorageVerificationError extends Error {
	constructor(readonly reason: 'missing' | 'size-mismatch') {
		super(`Stored file failed verification: ${reason}`);
	}
}

/**
 * Checks that a finished write really stored the bytes it was supposed to store, and returns the file
 * record to register. A missing object or a size mismatch is an error, never a silent success.
 */
export async function verifyStoredFile(
	bucket: R2Bucket,
	sessionId: string,
	fileId: string,
	expected: { size: number; filename: string; mimeType: string; isText: boolean },
): Promise<ChestFile> {
	const object = await bucket.head(fileKey(sessionId, fileId));
	if (!object) {
		throw new StorageVerificationError('missing');
	}
	if (object.size !== expected.size) {
		throw new StorageVerificationError('size-mismatch');
	}
	return {
		fileId,
		filename: expected.filename,
		size: expected.size,
		mimeType: expected.mimeType,
		isText: expected.isText,
		fileExtension: getFileExtension(expected.filename),
	};
}

// --- Chests ---

/**
 * Stores the manifest under a fresh retrieval code and closes the upload session.
 * The conditional put only succeeds if the code is unused, so collisions retry with a new code.
 * Returns null if no free code was found.
 */
export interface FinalizePlan {
	createdAt: number;
	files: ChestFile[];
	expiresAt: number | null;
	validityDays: number;
	fingerprint: string;
}

/**
 * Publishes a chest for a session that is already FINALIZING. Safe to call again after any failure:
 * every step either repeats harmlessly or is detected as already done.
 *
 *  1. Reserve the candidate code on the session (the same code is used on every retry)
 *  2. Claim codes/{code} with If-None-Match; a code owned by another session is replaced, never overwritten
 *  3. Write the expiry index (timed chests only)
 *  4. Move the session to COMPLETED with the result
 *  5. Remove the pending index entry
 *
 * Returns null only when no free code was found; the session is then rolled back to OPEN.
 */
export async function finalizeChest(bucket: R2Bucket, sessionId: string, plan: FinalizePlan): Promise<string | null> {
	let reserved = await reserveCandidateCode(bucket, sessionId, generateRetrievalCode());
	const startedAt = reserved.finalizeStartedAt;

	for (let attempt = 0; attempt < 5; attempt++) {
		const code = reserved.candidateCode as string;
		const manifest: ChestManifest = {
			version: 1,
			sessionId,
			createdAt: plan.createdAt,
			expiresAt: plan.expiresAt,
			files: plan.files,
		};

		const claimed = await bucket.put(codeKey(code), JSON.stringify(manifest), {
			httpMetadata: { contentType: 'application/json' },
			onlyIf: new Headers({ 'If-None-Match': '*' }),
		});
		if (claimed === null) {
			const owner = await readManifest(bucket, code);
			if (owner?.sessionId !== sessionId) {
				// Another chest already uses this code: pick a new one and try again
				reserved = await replaceCandidateCode(bucket, sessionId, code, generateRetrievalCode());
				continue;
			}
			// Claimed by an earlier attempt of this same completion: carry on
		}

		if (plan.expiresAt !== null) {
			await bucket.put(expiryKey(plan.expiresAt, code), '');
		}

		try {
			await transitionSession(bucket, sessionId, 'COMPLETED', {
				retrievalCode: code,
				validityDays: plan.validityDays,
				expiresAt: plan.expiresAt,
				fileIds: plan.files.map((file) => file.fileId),
			});
		} catch (error) {
			// A concurrent retry may have completed the session already, with the same code
			const current =
				error instanceof SessionError && error.code === 'INVALID_TRANSITION' ? await getSessionRecord(bucket, sessionId) : null;
			if (current?.record.status !== 'COMPLETED' || current.record.retrievalCode !== code) {
				throw error;
			}
		}

		await closeSession(bucket, sessionId, plan.createdAt);
		// Earlier uploads of retried files are not part of the share; failing here only delays their removal
		await removeUnreferencedObjects(
			bucket,
			sessionId,
			plan.files.map((file) => file.fileId),
		).catch(() => undefined);
		if (startedAt !== null) await bucket.delete(finalizingIndexKey(startedAt, sessionId));
		return code;
	}

	await transitionSession(bucket, sessionId, 'OPEN', {
		candidateCode: null,
		completionFingerprint: null,
		finalizeStartedAt: null,
		validityDays: null,
		expiresAt: null,
	});
	if (startedAt !== null) await bucket.delete(finalizingIndexKey(startedAt, sessionId));
	return null;
}

// Deletes the session's file objects that the completed share does not list. Only used once the session is COMPLETED.
async function removeUnreferencedObjects(bucket: R2Bucket, sessionId: string, fileIds: readonly string[]): Promise<number> {
	const keep = new Set(fileIds.map((fileId) => fileKey(sessionId, fileId)));
	const stray = (await listSessionKeys(bucket, sessionId)).filter((key) => !keep.has(key));
	await deleteKeys(bucket, stray);
	return stray.length;
}

async function readManifest(bucket: R2Bucket, code: string): Promise<ChestManifest | null> {
	const object = await bucket.get(codeKey(code));
	return object ? ((await object.json()) as ChestManifest) : null;
}

// Returns the chest for a code, or null if it does not exist or has expired
export async function getChest(bucket: R2Bucket, code: string, now: number): Promise<ChestManifest | null> {
	const manifest = await readManifest(bucket, code);
	if (!manifest || (manifest.expiresAt !== null && manifest.expiresAt <= now)) {
		return null;
	}

	// The manifest alone is not enough: the session must agree that this code was issued for it
	const session = await getSessionRecord(bucket, manifest.sessionId).catch(() => null);
	if (!session || session.record.status !== 'COMPLETED' || session.record.retrievalCode !== code) {
		return null;
	}
	return manifest;
}

/**
 * Aborts the R2 multipart uploads that are still ACTIVE for a session. Used when the session is
 * completed or cleaned up, so unfinished uploads cannot linger in R2. An upload that R2 no longer
 * knows about is already gone, so that case is not an error.
 */
export async function abortActiveMultipart(bucket: R2Bucket, sessionId: string, entries: readonly MultipartUploadEntry[]): Promise<void> {
	for (const entry of entries) {
		if (entry.state !== 'ACTIVE') continue;
		await bucket
			.resumeMultipartUpload(fileKey(sessionId, entry.fileId), entry.uploadId)
			.abort()
			.catch(() => undefined);
	}
}

// --- Cleanup ---

// A completion that has not finished after this long is rolled back by the cleanup job
export const FINALIZE_STALE_SECONDS = 60 * 60;
// Orphaned file objects are only removed this long after they were written, in case a request is still running
export const ORPHAN_GRACE_SECONDS = 48 * 60 * 60;
const ORPHAN_SCAN_BATCH = 1000;
const ORPHAN_CURSOR_KEY = 'maintenance/orphan-cursor.json';
const UUID_PATTERN = /^[0-9a-f-]{36}$/;

export interface CleanupResult {
	expiredChests: number;
	// Chests whose manifest or index disagreed with the session; kept and repaired instead of deleted
	repairedExpiry: number;
	abandonedSessions: number;
	rolledBackFinalizations: number;
	// Stuck completions that were finished from their stored plan instead of rolled back
	recoveredFinalizations: number;
	orphanCodeClaims: number;
	orphanClaims: number;
	orphanObjects: number;
	sessionsRemoved: number;
	throttlesReset: number;
	challengesRemoved: number;
	deletedObjects: number;
	// true when more due work exists than this run processed; the next run continues it
	backlog: { expired: boolean; abandoned: boolean; finalizing: boolean; sessions: boolean; challenges: boolean };
	errors: string[];
}

export function finalizingIndexKey(startedAt: number, sessionId: string): string {
	return `finalizing/${timestampSegment(startedAt)}/${sessionId}`;
}

// Index keys under `prefix` whose timestamp is <= cutoff, oldest first, up to `limit`
async function listDueKeys(
	bucket: R2Bucket,
	prefix: 'expiry/' | 'pending/' | 'finalizing/',
	cutoff: number,
	limit: number,
): Promise<{ keys: string[]; hasMore: boolean }> {
	const due: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix, cursor, limit: 1000 });
		for (const object of page.objects) {
			const timestamp = Number(object.key.slice(prefix.length).split('/')[0]);
			if (timestamp > cutoff) {
				return { keys: due, hasMore: false };
			}
			if (due.length >= limit) {
				return { keys: due, hasMore: true };
			}
			due.push(object.key);
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return { keys: due, hasMore: false };
}

async function deleteKeys(bucket: R2Bucket, keys: string[]): Promise<void> {
	for (let i = 0; i < keys.length; i += R2_DELETE_BATCH) {
		await bucket.delete(keys.slice(i, i + R2_DELETE_BATCH));
	}
}

async function listSessionKeys(bucket: R2Bucket, sessionId: string): Promise<string[]> {
	const keys: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix: `${sessionId}/`, cursor });
		keys.push(...page.objects.map((object) => object.key));
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return keys;
}

// Removes a session's content and its record. Only called when nothing refers to the content any more.
async function removeSession(bucket: R2Bucket, sessionId: string, multipartUploads: MultipartUploadEntry[]): Promise<number> {
	await abortActiveMultipart(bucket, sessionId, multipartUploads);
	const sessionKeys = await listSessionKeys(bucket, sessionId);
	// The record goes last among the session's objects: without it the session cannot be mistaken for live
	await deleteKeys(bucket, [...sessionKeys, sessionKey(sessionId)]);
	return sessionKeys.length;
}

/**
 * One pass of the cleanup job. Each category is bounded per run, so a large backlog is worked
 * through over several runs instead of exceeding the Worker's limits. Every deletion is repeatable.
 */
export async function cleanupExpired(bucket: R2Bucket, now: number): Promise<CleanupResult> {
	const result: CleanupResult = {
		expiredChests: 0,
		repairedExpiry: 0,
		abandonedSessions: 0,
		rolledBackFinalizations: 0,
		recoveredFinalizations: 0,
		orphanCodeClaims: 0,
		orphanClaims: 0,
		orphanObjects: 0,
		sessionsRemoved: 0,
		throttlesReset: 0,
		challengesRemoved: 0,
		deletedObjects: 0,
		backlog: { expired: false, abandoned: false, finalizing: false, sessions: false, challenges: false },
		errors: [],
	};

	// 1. Expired chests. An expiry entry only removes the session's content when the session still
	//    uses this code; otherwise the entry is a leftover claim and only its own objects go.
	const expired = await listDueKeys(bucket, 'expiry/', now, CLEANUP_BATCH_LIMIT);
	result.backlog.expired = expired.hasMore;
	for (const indexKey of expired.keys) {
		const code = indexKey.split('/')[2];
		try {
			const manifest = await readManifest(bucket, code);
			// Only a real "not found" (null) means the session is gone. A failed or unreadable read throws to the
			// handler below, which keeps everything and tries again on the next run.
			const session = manifest ? await getSessionRecord(bucket, manifest.sessionId) : null;
			const owns = session?.record.status === 'COMPLETED' && session.record.retrievalCode === code;

			const indexTimestamp = Number(indexKey.split('/')[1]);
			if (manifest && owns && (session.record.expiresAt !== indexTimestamp || manifest.expiresAt !== indexTimestamp)) {
				// The session decides. Nothing is deleted on a disagreement: bring manifest and index in line,
				// and let a later run delete the chest if it really is due.
				const truth = session.record.expiresAt;
				if (manifest.expiresAt !== truth) {
					await bucket.put(codeKey(code), JSON.stringify({ ...manifest, expiresAt: truth }), {
						httpMetadata: { contentType: 'application/json' },
					});
				}
				if (truth !== null) await bucket.put(expiryKey(truth, code), '');
				if (truth !== indexTimestamp) await deleteKeys(bucket, [indexKey]);
				result.repairedExpiry++;
				result.errors.push(`Expiry of chest ${code} disagreed between index, manifest and session; repaired`);
			} else if (manifest && owns) {
				result.deletedObjects += await removeSession(bucket, manifest.sessionId, session.record.multipartUploads);
				await deleteKeys(bucket, [codeKey(code), indexKey]);
				result.expiredChests++;
			} else {
				await deleteKeys(bucket, [codeKey(code), indexKey]);
				result.orphanClaims++;
			}
		} catch (error) {
			result.errors.push(`Failed to clean up chest ${code}: ${error}`);
		}
	}

	// 2. Sessions abandoned before completion (48 hours without completing)
	const abandoned = await listDueKeys(bucket, 'pending/', now - ABANDONED_SESSION_SECONDS, CLEANUP_BATCH_LIMIT);
	result.backlog.abandoned = abandoned.hasMore;
	for (const markerKey of abandoned.keys) {
		const sessionId = markerKey.split('/')[2];
		try {
			const current = await getSessionRecord(bucket, sessionId);
			if (current?.record.status === 'OPEN' || current?.record.status === 'ABANDONED') {
				result.deletedObjects += await removeSession(bucket, sessionId, current.record.multipartUploads);
				result.abandonedSessions++;
			} else if (current?.record.status === 'FINALIZING') {
				// Still completing: leave the session alone; step 3 decides whether it is stuck
				continue;
			}
			// Completed sessions keep their files; a leftover marker is only an index entry
			await deleteKeys(bucket, [markerKey]);
		} catch (error) {
			result.errors.push(`Failed to clean up session ${sessionId}: ${error}`);
		}
	}

	// 3. Completions that started long ago and never finished: roll them back so the client can retry
	const stuck = await listDueKeys(bucket, 'finalizing/', now - FINALIZE_STALE_SECONDS, CLEANUP_BATCH_LIMIT);
	result.backlog.finalizing = stuck.hasMore;
	for (const indexKey of stuck.keys) {
		const sessionId = indexKey.split('/')[2];
		try {
			const current = await getSessionRecord(bucket, sessionId);
			if (current?.record.status === 'FINALIZING') {
				if (await recoverFinalizing(bucket, current.record, now)) {
					result.recoveredFinalizations++;
				} else {
					result.rolledBackFinalizations++;
				}
			}
			await deleteKeys(bucket, [indexKey]);
		} catch (error) {
			result.errors.push(`Failed to repair session ${sessionId}: ${error}`);
		}
	}

	// 4. Owner sign-in sessions that have ended (revoked, idle, expired, or from an older owner version)
	try {
		const sessionScan: ScanState = { more: false };
		result.sessionsRemoved = await cleanupOwnerSessions(bucket, now, undefined, sessionScan);
		result.backlog.sessions = sessionScan.more;
	} catch (error) {
		result.errors.push(`Failed to clean up owner sessions: ${error}`);
	}

	// 4b. Sign-in failure counters that have been quiet for a long time; locked counters are never touched
	try {
		result.throttlesReset = await cleanupThrottles(bucket, now);
	} catch (error) {
		result.errors.push(`Failed to reset sign-in throttles: ${error}`);
	}

	// 4c. WebAuthn challenges past their expiry; live ones are never removed
	try {
		const challengeScan: ScanState = { more: false };
		result.challengesRemoved = await cleanupChallenges(bucket, now, undefined, challengeScan);
		result.backlog.challenges = challengeScan.more;
	} catch (error) {
		result.errors.push(`Failed to clean up passkey challenges: ${error}`);
	}

	// 4d. Code claims that no session owns any more
	try {
		result.orphanCodeClaims = await cleanupOrphanClaims(bucket, now);
	} catch (error) {
		result.errors.push(`Failed to scan for orphaned code claims: ${error}`);
	}

	// 5. Orphaned file objects: content whose session record is gone. Scanned in batches; the cursor persists.
	try {
		result.orphanObjects = await cleanupOrphanObjects(bucket, now, result);
	} catch (error) {
		result.errors.push(`Failed to scan for orphaned objects: ${error}`);
	}

	return result;
}

/**
 * Deals with a session that has been FINALIZING for too long. If its code was already claimed with a
 * manifest that matches the stored plan, the completion is finished (nothing the client could have
 * been told is lost). Otherwise the claim and its expiry entry are removed and the session goes back to OPEN.
 * Returns true when the completion was finished.
 */
async function recoverFinalizing(bucket: R2Bucket, record: SessionRecord, now: number): Promise<boolean> {
	const sessionId = record.sessionId;
	const code = record.candidateCode;
	const manifest = code ? await readManifest(bucket, code) : null;
	const claimed = manifest !== null && manifest.sessionId === sessionId;

	if (claimed && code && record.validityDays !== null && manifest.expiresAt === record.expiresAt) {
		const knownFiles = new Set(record.files.map((file) => file.fileId));
		if (manifest.files.length > 0 && manifest.files.every((file) => knownFiles.has(file.fileId))) {
			if (record.expiresAt !== null) await bucket.put(expiryKey(record.expiresAt, code), '');
			await transitionSession(
				bucket,
				sessionId,
				'COMPLETED',
				{ retrievalCode: code, fileIds: manifest.files.map((file) => file.fileId) },
				now,
			);
			await closeSession(bucket, sessionId, record.createdAt);
			return true;
		}
	}

	if (claimed && code) {
		await deleteKeys(bucket, [codeKey(code), ...(manifest.expiresAt !== null ? [expiryKey(manifest.expiresAt, code)] : [])]);
		if (record.expiresAt !== null && record.expiresAt !== manifest.expiresAt) await deleteKeys(bucket, [expiryKey(record.expiresAt, code)]);
	}
	await transitionSession(
		bucket,
		sessionId,
		'OPEN',
		{ candidateCode: null, completionFingerprint: null, finalizeStartedAt: null, validityDays: null, expiresAt: null },
		now,
	);
	return false;
}

const CODE_CURSOR_KEY = 'maintenance/code-claim-cursor.json';
const CODE_SCAN_BATCH = 500;

/**
 * Scans codes/ in batches (the cursor persists) and removes claims that their session does not back:
 * the session is gone, or it neither completed with this code nor is completing with it.
 */
async function cleanupOrphanClaims(bucket: R2Bucket, now: number): Promise<number> {
	const saved = await bucket.get(CODE_CURSOR_KEY);
	const cursor = saved ? (((await saved.json()) as { cursor?: string | null }).cursor ?? undefined) : undefined;
	const page = await bucket.list({ prefix: 'codes/', cursor, limit: CODE_SCAN_BATCH });

	let removed = 0;
	for (const object of page.objects) {
		const code = object.key.slice('codes/'.length);
		const manifest = await readManifest(bucket, code);
		if (!manifest) continue;
		const session = await getSessionRecord(bucket, manifest.sessionId).catch(() => 'unreadable' as const);
		if (session === 'unreadable') continue; // a corrupt record is not proof that the claim is unowned
		const owned =
			session !== null &&
			((session.record.status === 'COMPLETED' && session.record.retrievalCode === code) ||
				(session.record.status === 'FINALIZING' && session.record.candidateCode === code));
		if (owned) continue;
		await deleteKeys(bucket, [object.key, ...(manifest.expiresAt !== null ? [expiryKey(manifest.expiresAt, code)] : [])]);
		removed++;
	}

	await bucket.put(CODE_CURSOR_KEY, JSON.stringify({ cursor: page.truncated ? page.cursor : null }), {
		httpMetadata: { contentType: 'application/json' },
	});
	return removed;
}

async function cleanupOrphanObjects(bucket: R2Bucket, now: number, result: CleanupResult): Promise<number> {
	const saved = await bucket.get(ORPHAN_CURSOR_KEY);
	const cursor = saved ? (((await saved.json()) as { cursor?: string | null }).cursor ?? undefined) : undefined;
	const page = await bucket.list({ cursor, limit: ORPHAN_SCAN_BATCH });

	const sessions = new Map<string, SessionRecord | null | 'unreadable'>();
	let removed = 0;
	for (const object of page.objects) {
		const [sessionId, fileId] = object.key.split('/');
		if (!object.key.includes('/') || !UUID_PATTERN.test(sessionId) || !UUID_PATTERN.test(fileId ?? '')) continue;
		if (object.uploaded.getTime() / 1000 > now - ORPHAN_GRACE_SECONDS) continue;

		if (!sessions.has(sessionId)) {
			const found = await getSessionRecord(bucket, sessionId).catch(() => 'unreadable' as const);
			sessions.set(sessionId, found === 'unreadable' ? found : (found?.record ?? null));
		}
		const session = sessions.get(sessionId);
		if (session === 'unreadable') continue; // a corrupt record is not proof that the content is unowned
		// A session that is gone owns nothing. A completed one owns exactly the files it lists.
		const unreferenced = session === null || (session?.status === 'COMPLETED' && !session.fileIds?.includes(fileId));
		if (unreferenced) {
			await bucket.delete(object.key);
			removed++;
			result.deletedObjects++;
		}
	}

	// Continue from here next run; start over once the whole bucket has been scanned
	await bucket.put(ORPHAN_CURSOR_KEY, JSON.stringify({ cursor: page.truncated ? page.cursor : null }), {
		httpMetadata: { contentType: 'application/json' },
	});
	return removed;
}
