import { env } from 'cloudflare:test';
import { expect } from 'vitest';
import { testFetch, TEST_ORIGIN, TEST_OWNER_PASSWORD } from './test-setup';
import { mutateOwner } from '../../src/worker/auth/owner';
import { sealSeed } from '../../src/worker/auth/totp';

export interface SignedIn {
	cookie: string;
	csrfToken: string;
}

export function headersFor(session: SignedIn): Record<string, string> {
	return { Origin: TEST_ORIGIN, Cookie: session.cookie, 'X-PocketChest-CSRF': session.csrfToken, 'Content-Type': 'application/json' };
}

// Re-enters the password in this session, which opens the five-minute window
export async function reauthPassword(session: SignedIn): Promise<void> {
	const response = await testFetch(`${TEST_ORIGIN}/api/auth/reauth/password`, {
		method: 'POST',
		headers: headersFor(session),
		body: JSON.stringify({ password: TEST_OWNER_PASSWORD }),
	});
	expect(response.status).toBe(200);
	await response.text();
}

// Calls a signed-in endpoint and takes the replacement session when the response carries one
export async function call(session: SignedIn, method: string, path: string, body?: unknown) {
	const response = await testFetch(`${TEST_ORIGIN}${path}`, {
		method,
		headers: headersFor(session),
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return response;
}

// Adopts the session a rotating change issued, so the caller stays signed in
export async function adoptRotated(session: SignedIn, response: Response): Promise<{ data: any; session: SignedIn }> {
	const data = (await response.json()) as any;
	const cookie = (response.headers.get('Set-Cookie') ?? '').split(';')[0];
	return { data, session: cookie ? { cookie, csrfToken: data.csrfToken } : session };
}

// Gives the owner a configured method. `enabled` decides whether it is switched on.
export async function configureTotp(seed: Uint8Array, enabled: boolean) {
	const sealed = await sealSeed(seed, (env as unknown as { AUTH_ENCRYPTION_KEY?: string }).AUTH_ENCRYPTION_KEY);
	await mutateOwner(env.R2_STORAGE, (owner) => ({
		...owner,
		methods: {
			...owner.methods,
			totp: { enabled, encryptedSecret: sealed, lastAcceptedStep: null },
		},
	}));
}

export async function setEnabled(method: 'password' | 'totp' | 'passkey', enabled: boolean) {
	await mutateOwner(env.R2_STORAGE, (owner) => {
		const methods = { ...owner.methods };
		if (method === 'password') {
			methods.password = { ...methods.password, enabled };
		} else if (method === 'totp') {
			methods.totp = { ...methods.totp, enabled };
		} else {
			methods.passkey = { ...methods.passkey, enabled };
		}
		return { ...owner, methods };
	});
}
