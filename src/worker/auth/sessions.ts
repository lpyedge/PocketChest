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

export const OWNER_COOKIE = '__Host-pc_owner';
export const CSRF_HEADER = 'X-PocketChest-CSRF';
export const IDLE_SECONDS = 12 * 60 * 60;
export const ABSOLUTE_SECONDS = 7 * 24 * 60 * 60;
// Activity is written back at most this often, to keep writes low
const TOUCH_SECONDS = 5 * 60;

export interface OwnerSessionRecord {
	version: 1;
	createdAt: number;
	lastSeenAt: number;
	absoluteExpiresAt: number;
	ownerAuthVersion: number;
	reauthenticatedAt: number | null;
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
		(r.reauthenticatedAt === null || typeof r.reauthenticatedAt === 'number')
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
	const object = await bucket.get(key);
	if (!object) {
		return null;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(await object.text());
	} catch {
		return null;
	}
	if (!isRecord(parsed)) {
		return null;
	}

	if (now >= parsed.absoluteExpiresAt || now - parsed.lastSeenAt >= IDLE_SECONDS) {
		return null;
	}

	const owner = await loadOwner(bucket).catch(() => null);
	if (!owner || owner.owner.authVersion !== parsed.ownerAuthVersion) {
		return null;
	}

	if (now - parsed.lastSeenAt >= TOUCH_SECONDS) {
		const touched: OwnerSessionRecord = { ...parsed, lastSeenAt: now };
		await bucket.put(key, JSON.stringify(touched), { httpMetadata: { contentType: 'application/json' } });
		return { key, record: touched, sid };
	}
	return { key, record: parsed, sid };
}

export async function revokeOwnerSession(bucket: R2Bucket, sid: string): Promise<void> {
	await bucket.delete(sessionKey(await sha256Hex(sid)));
}

export function sameOrigin(request: Request): boolean {
	const origin = request.headers.get('Origin');
	return origin !== null && origin === new URL(request.url).origin;
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
export async function cleanupOwnerSessions(bucket: R2Bucket, now: number, limit = 500): Promise<number> {
	const owner = await loadOwner(bucket).catch(() => null);
	const page = await bucket.list({ prefix: 'auth/sessions/', limit });
	let removed = 0;
	for (const object of page.objects) {
		const stored = await bucket.get(object.key);
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
		if (stale) {
			await bucket.delete(object.key);
			removed++;
		}
	}
	return removed;
}
