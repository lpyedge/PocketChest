import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { testFetch, resetStorage } from './utils/test-setup';
import {
	issueOwnerSession,
	loadOwnerSession,
	revokeOwnerSession,
	OWNER_COOKIE,
	IDLE_SECONDS,
	ABSOLUTE_SECONDS,
} from '../src/worker/auth/sessions';
import { createOwnerOnce, mutateOwner } from '../src/worker/auth/owner';
import { cleanupExpired } from '../src/worker/storage';

const bucket = () => env.R2_STORAGE;
const ORIGIN = 'http://example.com';
const NOW = 1_800_000_000;

async function signedIn(): Promise<{ sid: string; csrfToken: string; cookie: string }> {
	await createOwnerOnce(bucket(), 'owner-session-password');
	const issued = await issueOwnerSession(bucket(), env.JWT_SECRET, 1, NOW);
	return { sid: issued.sid, csrfToken: issued.csrfToken, cookie: `${OWNER_COOKIE}=${issued.sid}` };
}

function get(path: string, cookie?: string) {
	return testFetch(`${ORIGIN}${path}`, { headers: cookie ? { Cookie: cookie } : {} });
}

function post(path: string, headers: Record<string, string> = {}) {
	return testFetch(`${ORIGIN}${path}`, { method: 'POST', headers });
}

describe('owner session cookie', () => {
	beforeEach(async () => {
		await resetStorage();
	});

	it('is issued as __Host- prefixed, HttpOnly, Secure, SameSite=Strict, path-wide and without Domain', async () => {
		await createOwnerOnce(bucket(), 'owner-session-password');
		const { cookie } = await issueOwnerSession(bucket(), env.JWT_SECRET, 1, NOW);

		expect(cookie).toMatch(new RegExp(`^${OWNER_COOKIE}=[A-Za-z0-9_-]+;`));
		expect(cookie).toContain('Path=/');
		expect(cookie).toContain('HttpOnly');
		expect(cookie).toContain('Secure');
		expect(cookie).toContain('SameSite=Strict');
		expect(cookie).not.toMatch(/Domain=/i);
	});

	it('stores only a hash of the session id, never the cookie value or the CSRF token', async () => {
		const { sid, csrfToken } = await signedIn();
		const keys = (await bucket().list({ prefix: 'auth/sessions/' })).objects.map((o) => o.key);
		const stored = await (await bucket().get(keys[0]))!.text();

		expect(keys).toHaveLength(1);
		expect(keys[0]).toMatch(/^auth\/sessions\/[0-9a-f]{64}$/);
		expect(keys[0]).not.toContain(sid);
		expect(stored).not.toContain(sid);
		expect(stored).not.toContain(csrfToken);
	});

	it('reports anonymous callers as not authenticated, without leaking anything', async () => {
		await createOwnerOnce(bucket(), 'owner-session-password');
		const response = await get('/api/auth/session');

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ authenticated: false });
	});

	it('reports a valid session with its CSRF token', async () => {
		const { cookie, csrfToken } = await signedIn();
		const response = await get('/api/auth/session', cookie);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ authenticated: true, csrfToken });
	});

	it('treats a forged or unknown cookie as not authenticated', async () => {
		await signedIn();
		const response = await get('/api/auth/session', `${OWNER_COOKIE}=${'A'.repeat(43)}`);
		expect(await response.json()).toEqual({ authenticated: false });
	});

	it('answers an unauthenticated logout with 401', async () => {
		await signedIn();
		const response = await post('/api/auth/logout', { Origin: ORIGIN });
		expect(response.status).toBe(401);
		await response.text();
	});

	it('logs out: the session is revoked and the cookie is cleared', async () => {
		const { cookie, csrfToken } = await signedIn();
		const response = await post('/api/auth/logout', { Origin: ORIGIN, Cookie: cookie, 'X-PocketChest-CSRF': csrfToken });

		expect(response.status).toBe(200);
		expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
		await response.text();
		expect(await (await get('/api/auth/session', cookie)).json()).toEqual({ authenticated: false });
	});

	it('rejects a state-changing request without the CSRF header', async () => {
		const { cookie } = await signedIn();
		const response = await post('/api/auth/logout', { Origin: ORIGIN, Cookie: cookie });
		expect(response.status).toBe(403);
		expect(((await response.json()) as any).code).toBe('CSRF_REJECTED');
	});

	it('rejects a wrong CSRF token', async () => {
		const { cookie } = await signedIn();
		const response = await post('/api/auth/logout', { Origin: ORIGIN, Cookie: cookie, 'X-PocketChest-CSRF': 'wrong' });
		expect(response.status).toBe(403);
		await response.text();
	});

	it('rejects a state-changing request from another origin, or without an Origin', async () => {
		const { cookie, csrfToken } = await signedIn();
		const crossOrigin = await post('/api/auth/logout', { Origin: 'https://evil.example', Cookie: cookie, 'X-PocketChest-CSRF': csrfToken });
		const noOrigin = await post('/api/auth/logout', { Cookie: cookie, 'X-PocketChest-CSRF': csrfToken });

		expect(crossOrigin.status).toBe(403);
		expect(noOrigin.status).toBe(403);
		await crossOrigin.text();
		await noOrigin.text();
		// The session survives rejected requests
		expect((await (await get('/api/auth/session', cookie)).json()) as any).toMatchObject({ authenticated: true });
	});

	it('expires after the idle limit without activity, and after the absolute limit even with activity', async () => {
		await createOwnerOnce(bucket(), 'owner-session-password');

		// Idle: never used since issue
		const idle = await issueOwnerSession(bucket(), env.JWT_SECRET, 1, NOW);
		expect(await loadOwnerSession(bucket(), idle.sid, NOW + IDLE_SECONDS + 60)).toBeNull();

		// Idle counted from the last use, not from issue
		const used = await issueOwnerSession(bucket(), env.JWT_SECRET, 1, NOW);
		expect(await loadOwnerSession(bucket(), used.sid, NOW + 3600)).not.toBeNull();
		const lastUse = NOW + 3600 + IDLE_SECONDS - 60;
		expect(await loadOwnerSession(bucket(), used.sid, lastUse)).not.toBeNull();
		expect(await loadOwnerSession(bucket(), used.sid, lastUse + IDLE_SECONDS)).toBeNull();

		// Absolute: kept active every few hours, still ends after the absolute limit
		const busy = await issueOwnerSession(bucket(), env.JWT_SECRET, 1, NOW);
		for (let t = NOW; t < NOW + ABSOLUTE_SECONDS - 3600; t += 6 * 3600) {
			expect(await loadOwnerSession(bucket(), busy.sid, t)).not.toBeNull();
		}
		expect(await loadOwnerSession(bucket(), busy.sid, NOW + ABSOLUTE_SECONDS + 60)).toBeNull();
	});

	it('is invalidated for every session when the owner authVersion changes', async () => {
		await createOwnerOnce(bucket(), 'owner-session-password');
		const first = await issueOwnerSession(bucket(), env.JWT_SECRET, 1, NOW);
		const second = await issueOwnerSession(bucket(), env.JWT_SECRET, 1, NOW);
		expect(await loadOwnerSession(bucket(), first.sid, NOW)).not.toBeNull();

		await mutateOwner(bucket(), (owner) => ({ ...owner, authVersion: owner.authVersion + 1 }));

		expect(await loadOwnerSession(bucket(), first.sid, NOW)).toBeNull();
		expect(await loadOwnerSession(bucket(), second.sid, NOW)).toBeNull();
	});

	it('removes revoked sessions and expired sessions in the cleanup job, but keeps live ones', async () => {
		await createOwnerOnce(bucket(), 'owner-session-password');
		const live = await issueOwnerSession(bucket(), env.JWT_SECRET, 1, NOW);
		const expired = await issueOwnerSession(bucket(), env.JWT_SECRET, 1, NOW - ABSOLUTE_SECONDS - 10);
		const revoked = await issueOwnerSession(bucket(), env.JWT_SECRET, 1, NOW);
		await revokeOwnerSession(bucket(), revoked.sid);

		await cleanupExpired(bucket(), NOW);

		expect(await loadOwnerSession(bucket(), live.sid, NOW)).not.toBeNull();
		expect(await loadOwnerSession(bucket(), expired.sid, NOW)).toBeNull();
		const keys = (await bucket().list({ prefix: 'auth/sessions/' })).objects.map((o) => o.key);
		expect(keys).toHaveLength(1);
	});

	it('marks every API response no-store, nosniff and no-referrer', async () => {
		await createOwnerOnce(bucket(), 'owner-session-password');
		for (const response of [await get('/api/auth/session'), await get('/api/missing')]) {
			expect(response.headers.get('Cache-Control')).toBe('no-store');
			expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
			expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
			await response.text();
		}
	});
});
