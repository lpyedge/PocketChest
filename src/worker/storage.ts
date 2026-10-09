import { ChestFile, ChestManifest } from './types';
import { createSessionRecord, getSessionRecord, sessionKey, SessionError, transitionSession } from './session';
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
export async function createChest(bucket: R2Bucket, manifest: ChestManifest): Promise<string | null> {
	// The caller has already moved the session to FINALIZING (see beginFinalize)
	const code = await claimRetrievalCode(bucket, manifest);
	if (!code) {
		await transitionSession(bucket, manifest.sessionId, 'OPEN');
		return null;
	}

	await transitionSession(bucket, manifest.sessionId, 'COMPLETED', {
		retrievalCode: code,
		validityDays: manifest.expiresAt === null ? -1 : null,
		expiresAt: manifest.expiresAt,
		fileIds: manifest.files.map((file) => file.fileId),
	});
	await closeSession(bucket, manifest.sessionId, manifest.createdAt);
	return code;
}

async function claimRetrievalCode(bucket: R2Bucket, manifest: ChestManifest): Promise<string | null> {
	for (let attempt = 0; attempt < 5; attempt++) {
		const code = generateRetrievalCode();
		const stored = await bucket.put(codeKey(code), JSON.stringify(manifest), {
			httpMetadata: { contentType: 'application/json' },
			onlyIf: new Headers({ 'If-None-Match': '*' }),
		});
		if (stored === null) {
			continue;
		}

		if (manifest.expiresAt !== null) {
			try {
				await bucket.put(expiryKey(manifest.expiresAt, code), '');
			} catch (error) {
				// Without an index entry the chest would never be cleaned up, so don't leave it behind
				await bucket.delete(codeKey(code));
				throw error;
			}
		}

		return code;
	}
	return null;
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
	return manifest;
}

// --- Cleanup ---

export interface CleanupResult {
	expiredChests: number;
	abandonedSessions: number;
	deletedObjects: number;
	errors: string[];
}

// Lists keys under an index prefix whose timestamp segment is <= cutoff, oldest first
async function listDueKeys(bucket: R2Bucket, prefix: 'expiry/' | 'pending/', cutoff: number): Promise<string[]> {
	const due: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix, cursor, limit: 1000 });
		for (const object of page.objects) {
			const timestamp = Number(object.key.slice(prefix.length).split('/')[0]);
			if (timestamp > cutoff || due.length >= CLEANUP_BATCH_LIMIT) {
				return due;
			}
			due.push(object.key);
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return due;
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

export async function cleanupExpired(bucket: R2Bucket, now: number): Promise<CleanupResult> {
	const result: CleanupResult = { expiredChests: 0, abandonedSessions: 0, deletedObjects: 0, errors: [] };

	for (const indexKey of await listDueKeys(bucket, 'expiry/', now)) {
		const code = indexKey.split('/')[2];
		try {
			const manifest = await readManifest(bucket, code);
			const sessionKeys = manifest ? await listSessionKeys(bucket, manifest.sessionId) : [];
			// Index entry last: if anything fails, the next run retries this chest
			const recordKeys = manifest ? [sessionKey(manifest.sessionId)] : [];
			await deleteKeys(bucket, [...sessionKeys, ...recordKeys, codeKey(code), indexKey]);
			result.deletedObjects += sessionKeys.length;
			result.expiredChests++;
		} catch (error) {
			result.errors.push(`Failed to delete chest ${code}: ${error}`);
		}
	}

	for (const markerKey of await listDueKeys(bucket, 'pending/', now - ABANDONED_SESSION_SECONDS)) {
		const sessionId = markerKey.split('/')[2];
		try {
			const current = await getSessionRecord(bucket, sessionId).catch(() => null);
			if (current?.record.status !== 'OPEN') {
				// Completed (or unknown) sessions keep their files; only the stale index entry goes
				await deleteKeys(bucket, [markerKey]);
				continue;
			}
			const sessionKeys = await listSessionKeys(bucket, sessionId);
			await deleteKeys(bucket, [...sessionKeys, sessionKey(sessionId), markerKey]);
			result.deletedObjects += sessionKeys.length;
			result.abandonedSessions++;
		} catch (error) {
			result.errors.push(`Failed to delete abandoned session ${sessionId}: ${error}`);
		}
	}

	return result;
}
