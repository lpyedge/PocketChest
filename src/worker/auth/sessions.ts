/**
 * Owner sign-in sessions. The browser holds a random session id in an HttpOnly cookie. The server
 * keeps only SHA-256(session id) and SHA-256(CSRF token) under auth/sessions/{sha256(sid)}.
 *
 * A session ends when it is revoked, after IDLE_SECONDS without use, after ABSOLUTE_SECONDS from
 * sign-in, or as soon as the owner's authVersion changes (password change, method change, recovery).
 */
import { ApiError } from '../errors';
import { constantTimeEqual, toBase64Url } from './encoding';
import { loadOwner } from './owner';
import { scanBatch, ScanState } from './scan';

export const OWNER_COOKIE = '__Host-pc_owner';
export const CSRF_HEADER = 'X-PocketChest-CSRF';
export const IDLE_SECONDS = 12 * 60 * 60;
export const ABSOLUTE_SECONDS = 7 * 24 * 60 * 60;
// Activity is written back at most this often, to keep writes low
const TOUCH_SECONDS = 5 * 60;

export type ReauthMethod = 'password' | 'totp' | 'passkey';

export interface OwnerSessionRecord {
	version: 1;
	createdAt: number;
	lastSeenAt: number;
	absoluteExpiresAt: number;
	ownerAuthVersion: number;
	reauthenticatedAt: number | null;
	// Which sign-in method the last re-entry used
	reauthMethod: ReauthMethod | null;
	// Proof that the owner still holds a method that is switched off, given so it can be switched on again.
	// It is separate from the re-entry above and opens nothing else.
	activationProof?: { method: ReauthMethod; at: number };
}

export interface LoadedSession {
	key: string;
	record: OwnerSessionRecord;
	sid: string;
}

export async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomToken(): string {
	return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

// The CSRF token is derived from the session id with a server secret, so it is never stored and can
// be shown again to the page that holds the cookie. Other sites cannot read it (same-origin policy).
export async function csrfTokenFor(secret: string, sid: string): Promise<string> {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`csrf:${sid}`));
	return toBase64Url(new Uint8Array(mac));
}

export function sessionKey(sessionIdHash: string): string {
	return `auth/sessions/${sessionIdHash}`;
}

export function sessionCookie(sid: string): string {
	return `${OWNER_COOKIE}=${sid}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

export function clearedSessionCookie(): string {
	return `${OWNER_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export function readSessionId(cookieHeader: string | null): string | null {
	for (const part of (cookieHeader ?? '').split(';')) {
		const [name, ...rest] = part.trim().split('=');
		if (name === OWNER_COOKIE) {
			const value = rest.join('=');
			return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
		}
	}
	return null;
}

function isRecord(value: unknown): value is OwnerSessionRecord {
	const r = value as Record<string, unknown>;
	return (
		typeof r === 'object' &&
		r !== null &&
		r.version === 1 &&
		typeof r.createdAt === 'number' &&
		typeof r.lastSeenAt === 'number' &&
		typeof r.absoluteExpiresAt === 'number' &&
		typeof r.ownerAuthVersion === 'number' &&
		(r.reauthenticatedAt === null || typeof r.reauthenticatedAt === 'number') &&
		(r.reauthMethod === null || r.reauthMethod === 'password' || r.reauthMethod === 'totp' || r.reauthMethod === 'passkey')
	);
}

/** Starts a session. Returns the cookie value to set and the CSRF token the page must echo back. */
export async function issueOwnerSession(
	bucket: R2Bucket,
	secret: string,
	ownerAuthVersion: number,
	now: number = Math.floor(Date.now() / 1000),
): Promise<{ sid: string; csrfToken: string; cookie: string }> {
	const sid = randomToken();
	const csrfToken = await csrfTokenFor(secret, sid);
	const record: OwnerSessionRecord = {
		version: 1,
		createdAt: now,
		lastSeenAt: now,
		absoluteExpiresAt: now + ABSOLUTE_SECONDS,
		ownerAuthVersion,
		reauthenticatedAt: null,
		reauthMethod: null,
	};
	await bucket.put(sessionKey(await sha256Hex(sid)), JSON.stringify(record), {
		httpMetadata: { contentType: 'application/json' },
		onlyIf: new Headers({ 'If-None-Match': '*' }),
	});
	return { sid, csrfToken, cookie: sessionCookie(sid) };
}

/**
 * Returns the session if it is still valid for the current owner, or null. A valid session that has
 * been idle for a while is refreshed, so long-running use does not run into the idle limit.
 */
export async function loadOwnerSession(
	bucket: R2Bucket,
	sid: string,
	now: number = Math.floor(Date.now() / 1000),
): Promise<LoadedSession | null> {
	const key = sessionKey(await sha256Hex(sid));
	// One retry is enough: the second read sees whatever a concurrent request or logout wrote
	for (let attempt = 0; attempt < 2; attempt++) {
		const object = await bucket.get(key);
		if (!object) {
			return null;
		}
		const parsed = parseRecord(await object.text());
		if (!parsed) {
			return null;
		}
		if (now >= parsed.absoluteExpiresAt || now - parsed.lastSeenAt >= IDLE_SECONDS) {
			return null;
		}

		const owner = await loadOwner(bucket).catch(() => null);
		if (!owner || owner.owner.authVersion !== parsed.ownerAuthVersion) {
			return null;
		}

		if (now - parsed.lastSeenAt < TOUCH_SECONDS) {
			return { key, record: parsed, sid };
		}
		const touched: OwnerSessionRecord = { ...parsed, lastSeenAt: now };
		if (await replaceRecord(bucket, key, object.etag, touched)) {
			return { key, record: touched, sid };
		}
	}
	return null;
}

/**
 * Records that the owner just entered their password again. Only the session record changes, and
 * only if it is still the one that was read, so a logout that lands meanwhile is not undone.
 */
export async function markReauthenticated(
	bucket: R2Bucket,
	sid: string,
	now: number,
	method: ReauthMethod,
	at: number = now,
): Promise<void> {
	const key = sessionKey(await sha256Hex(sid));
	for (let attempt = 0; attempt < 3; attempt++) {
		const object = await bucket.get(key);
		const parsed = object ? parseRecord(await object.text()) : null;
		if (!object || !parsed) {
			throw new ApiError(401, 'AUTH_INVALID', 'Sign in required');
		}
		if (await replaceRecord(bucket, key, object.etag, { ...parsed, reauthenticatedAt: at, reauthMethod: method })) {
			return;
		}
	}
	throw new ApiError(409, 'CONFLICT', 'Session changed, try again');
}

/**
 * Records a proof of holding `method`, for switching that method on. Unlike a re-entry it does not open the
 * window that password changes and other settings need.
 */
export async function markActivationProof(bucket: R2Bucket, sid: string, now: number, method: ReauthMethod): Promise<void> {
	const key = sessionKey(await sha256Hex(sid));
	for (let attempt = 0; attempt < 3; attempt++) {
		const object = await bucket.get(key);
		const parsed = object ? parseRecord(await object.text()) : null;
		if (!object || !parsed) {
			throw new ApiError(401, 'AUTH_INVALID', 'Sign in required');
		}
		if (await replaceRecord(bucket, key, object.etag, { ...parsed, activationProof: { method, at: now } })) {
			return;
		}
	}
	throw new ApiError(409, 'CONFLICT', 'Session changed, try again');
}

// Enforces the short window after a password re-entry that sensitive changes require
export const REAUTH_SECONDS = 5 * 60;

export function assertActivationProof(session: LoadedSession, now: number, method: ReauthMethod): void {
	const proof = session.record.activationProof;
	if (!proof || proof.method !== method || now - proof.at >= REAUTH_SECONDS || proof.at > now) {
		throw new ApiError(403, 'ACTIVATION_PROOF_REQUIRED', `Prove you hold ${method} to switch it on`);
	}
}

export function assertRecentReauth(session: LoadedSession, now: number, method?: ReauthMethod): void {
	const { reauthenticatedAt: at, reauthMethod } = session.record;
	if (at === null || now - at >= REAUTH_SECONDS || at > now) {
		throw new ApiError(403, 'REAUTH_REQUIRED', 'Confirm your sign-in to continue');
	}
	if (method !== undefined && reauthMethod !== method) {
		throw new ApiError(403, 'REAUTH_METHOD_REQUIRED', `Confirm with ${method} to continue`);
	}
}

function parseRecord(text: string): OwnerSessionRecord | null {
	try {
		const parsed: unknown = JSON.parse(text);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

// Writes only if the object still has the etag that was read. A concurrent logout deletes it, so
// the write fails instead of bringing the session back.
async function replaceRecord(bucket: R2Bucket, key: string, etag: string, record: OwnerSessionRecord): Promise<boolean> {
	const stored = await bucket.put(key, JSON.stringify(record), {
		httpMetadata: { contentType: 'application/json' },
		onlyIf: { etagMatches: etag },
	});
	return stored !== null;
}

export async function revokeOwnerSession(bucket: R2Bucket, sid: string): Promise<void> {
	await bucket.delete(sessionKey(await sha256Hex(sid)));
}

export function sameOrigin(request: Request): boolean {
	const origin = request.headers.get('Origin');
	return origin !== null && origin === new URL(request.url).origin;
}

/** Endpoints that start a session (login, bootstrap) have no cookie yet, so only the Origin can be checked */
export function assertSameOrigin(request: Request): void {
	if (!sameOrigin(request)) {
		throw new ApiError(403, 'CSRF_REJECTED', 'Request origin is not allowed');
	}
}

/**
 * Who is calling as the owner. `mutating` requests must come from this origin and carry the CSRF
 * token of the session. Anything else is refused, and no state is changed.
 */
export async function requireOwner(
	request: Request,
	bucket: R2Bucket,
	secret: string,
	options: { mutating: boolean; now?: number },
): Promise<LoadedSession> {
	const sid = readSessionId(request.headers.get('Cookie'));
	if (!sid) {
		throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in required');
	}
	const session = await loadOwnerSession(bucket, sid, options.now);
	if (!session) {
		throw new ApiError(401, 'AUTH_INVALID', 'Sign in required');
	}
	if (options.mutating) {
		if (!sameOrigin(request)) {
			throw new ApiError(403, 'CSRF_REJECTED', 'Request origin is not allowed');
		}
		const presented = request.headers.get(CSRF_HEADER) ?? '';
		const expected = new TextEncoder().encode(await csrfTokenFor(secret, sid));
		if (!constantTimeEqual(new TextEncoder().encode(presented), expected)) {
			throw new ApiError(403, 'CSRF_REJECTED', 'Missing or invalid CSRF token');
		}
	}
	return session;
}

/** Deletes sessions that can no longer be used. Bounded per run; the next run continues. */
export async function cleanupOwnerSessions(bucket: R2Bucket, now: number, limit = 500, state?: ScanState): Promise<number> {
	const owner = await loadOwner(bucket).catch(() => null);
	return scanBatch(bucket, 'auth/sessions/', limit, state, async (key) => {
		const stored = await bucket.get(key);
		let stale = true;
		if (stored) {
			try {
				const parsed = JSON.parse(await stored.text());
				stale =
					!isRecord(parsed) ||
					now >= parsed.absoluteExpiresAt ||
					now - parsed.lastSeenAt >= IDLE_SECONDS ||
					(owner !== null && owner.owner.authVersion !== parsed.ownerAuthVersion);
			} catch {
				stale = true;
			}
		}
		if (stale) await bucket.delete(key);
		return stale;
	});
}
