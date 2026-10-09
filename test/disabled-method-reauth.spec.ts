import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import {
	ownerRecord,
	ownerSignIn,
	resetStorage,
	setupTestEnvironment,
	testFetch,
	TEST_ORIGIN,
	TEST_OWNER_PASSWORD,
} from './utils/test-setup';
import { adoptRotated, call, configureTotp, reauthPassword, setEnabled, SignedIn } from './utils/security-helpers';
import { totpCodeAt } from '../src/worker/auth/totp';
import { VirtualAuthenticator } from './utils/virtual-authenticator';
import { mutateOwner } from '../src/worker/auth/owner';
import { sessionKey, sha256Hex } from '../src/worker/auth/sessions';

const SEED = new Uint8Array(20).map((_, index) => 120 + index);
const RP_ID = new URL(TEST_ORIGIN).hostname;
const bucket = () => env.R2_STORAGE;

const nowSeconds = () => Math.floor(Date.now() / 1000);
const post = (session: SignedIn, path: string, body: unknown = {}) => call(session, 'POST', path, body);

async function code(offsetSteps = 0): Promise<string> {
	return totpCodeAt(SEED, nowSeconds() + offsetSteps * 30);
}

async function sessionRecord(session: SignedIn) {
	const sid = session.cookie.split('=')[1];
	return JSON.parse(await (await bucket().get(sessionKey(await sha256Hex(sid))))!.text());
}

async function codeOf(response: Response): Promise<string> {
	return ((await response.json()) as any).code;
}

async function enrollPasskey(owner: SignedIn, authenticator: VirtualAuthenticator): Promise<string> {
	await reauthPassword(owner);
	const options = (await (await post(owner, '/api/admin/passkeys/register/options')).json()) as any;
	const response = await authenticator.register(options);
	const verify = await post(owner, '/api/admin/passkeys/register/verify', { challenge: options.challenge, response, label: 'Key' });
	expect(verify.status).toBe(200);
	await verify.text();
	return response.id;
}

describe('N2-03 a method that is switched off cannot re-enter the session', () => {
	beforeEach(async () => {
		await resetStorage();
		await setupTestEnvironment();
	});

	it('T07: with the password off, password re-entry is refused and the authenticator still works', async () => {
		const owner = await ownerSignIn();
		await configureTotp(SEED, true);
		await setEnabled('password', false);

		const refused = await post(owner, '/api/auth/reauth/password', { password: TEST_OWNER_PASSWORD });
		expect(refused.status).toBe(403);
		expect(await codeOf(refused)).toBe('AUTH_METHOD_DISABLED');
		expect((await sessionRecord(owner)).reauthenticatedAt).toBeNull();

		const allowed = await post(owner, '/api/auth/reauth/totp', { code: await code() });
		expect(allowed.status).toBe(200);
		await allowed.text();
		expect((await sessionRecord(owner)).reauthMethod).toBe('totp');
	});

	it('T08: with the authenticator off, its code cannot re-enter the session', async () => {
		const owner = await ownerSignIn();
		await configureTotp(SEED, false);

		const refused = await post(owner, '/api/auth/reauth/totp', { code: await code() });

		expect(refused.status).toBe(403);
		expect(await codeOf(refused)).toBe('AUTH_METHOD_DISABLED');
		expect((await sessionRecord(owner)).reauthenticatedAt).toBeNull();
	});

	it('T08: with the passkey off, no passkey challenge is issued and an old one is not accepted', async () => {
		const authenticator = new VirtualAuthenticator(RP_ID, TEST_ORIGIN);
		const owner = await ownerSignIn();
		const credentialId = await enrollPasskey(owner, authenticator);

		const off = await post(owner, '/api/auth/reauth/passkey/options');
		expect(off.status).toBe(403);
		await off.text();

		// A challenge issued while it was on does not survive switching it off
		await mutateOwner(bucket(), (record) => ({
			...record,
			methods: { ...record.methods, passkey: { ...record.methods.passkey, enabled: true } },
		}));
		const options = (await (await post(owner, '/api/auth/reauth/passkey/options')).json()) as any;
		const assertion = await authenticator.assert(options, credentialId);
		await mutateOwner(bucket(), (record) => ({
			...record,
			methods: { ...record.methods, passkey: { ...record.methods.passkey, enabled: false } },
		}));
		const late = await post(owner, '/api/auth/reauth/passkey/verify', { challenge: options.challenge, response: assertion });
		expect(late.status).toBe(401);
		await late.text();
		// Only the password re-entry made while enrolling is on record
		expect((await sessionRecord(owner)).reauthMethod).toBe('password');
	});

	it('T09: once a method has been switched off, its re-entry fails for the old and the new session alike', async () => {
		const first = await ownerSignIn();
		await configureTotp(SEED, true);
		await reauthPassword(first);

		const toggled = await call(first, 'PATCH', '/api/admin/security/methods', { method: 'password', enabled: false });
		expect(toggled.status).toBe(200);
		const { session: replaced } = await adoptRotated(first, toggled);

		const oldSession = await post(first, '/api/auth/reauth/password', { password: TEST_OWNER_PASSWORD });
		expect(oldSession.status).toBe(401);
		await oldSession.text();
		const newSession = await post(replaced, '/api/auth/reauth/password', { password: TEST_OWNER_PASSWORD });
		expect(newSession.status).toBe(403);
		expect(await codeOf(newSession)).toBe('AUTH_METHOD_DISABLED');
	});

	it('T09: a password re-entry racing a switch-off never opens the window afterwards', async () => {
		const owner = await ownerSignIn();
		await configureTotp(SEED, true);
		await reauthPassword(owner);

		const [toggle, reentry] = await Promise.all([
			call(owner, 'PATCH', '/api/admin/security/methods', { method: 'password', enabled: false }),
			post(owner, '/api/auth/reauth/password', { password: TEST_OWNER_PASSWORD }),
		]);
		await toggle.text();
		await reentry.text();

		// Whatever the order, the owner now has the password off, and nobody can re-enter with it
		expect((await ownerRecord()).methods.password.enabled).toBe(false);
		const record = await sessionRecord(owner).catch(() => null);
		expect(record === null || record.reauthMethod !== 'password' || record.reauthenticatedAt !== null).toBe(true);
		const after = await post(owner, '/api/auth/reauth/password', { password: TEST_OWNER_PASSWORD });
		expect([401, 403]).toContain(after.status);
		await after.text();
	});
});

describe('N2-03 switching a method back on needs its own proof, which opens nothing else', () => {
	beforeEach(async () => {
		await resetStorage();
		await setupTestEnvironment();
	});

	it('refuses to switch a method on without a proof of it', async () => {
		const owner = await ownerSignIn();
		await configureTotp(SEED, false);
		await reauthPassword(owner);

		const response = await call(owner, 'PATCH', '/api/admin/security/methods', { method: 'totp', enabled: true });

		expect(response.status).toBe(403);
		expect(await codeOf(response)).toBe('ACTIVATION_PROOF_REQUIRED');
	});

	it('proof with the method itself, then switch it on; the proof is not a re-entry', async () => {
		const owner = await ownerSignIn();
		await configureTotp(SEED, false);

		const proof = await post(owner, '/api/auth/activate/totp', { code: await code() });
		expect(proof.status).toBe(200);
		await proof.text();

		// The proof alone does not open the re-entry window for anything else
		const record = await sessionRecord(owner);
		expect(record.reauthenticatedAt).toBeNull();
		const password = await call(owner, 'POST', '/api/admin/security/password', {
			newPassword: 'another-long-password-1',
			confirmPassword: 'another-long-password-1',
		});
		expect(password.status).toBe(403);
		expect(await codeOf(password)).toBe('REAUTH_REQUIRED');

		// A usable method's re-entry plus the proof switches it on
		await reauthPassword(owner);
		const toggled = await call(owner, 'PATCH', '/api/admin/security/methods', { method: 'totp', enabled: true });
		expect(toggled.status).toBe(200);
		await toggled.text();
		expect((await ownerRecord()).methods.totp.enabled).toBe(true);
	});

	it('a proof for one method does not switch on another', async () => {
		const owner = await ownerSignIn();
		await configureTotp(SEED, false);
		await post(owner, '/api/auth/activate/totp', { code: await code() }).then((r) => r.text());
		await reauthPassword(owner);

		const response = await call(owner, 'PATCH', '/api/admin/security/methods', { method: 'passkey', enabled: true });

		expect([403, 409]).toContain(response.status);
		await response.text();
	});

	it('a wrong proof is refused and counts against the same guess budget', async () => {
		const owner = await ownerSignIn();
		await configureTotp(SEED, false);

		const wrong = await post(owner, '/api/auth/activate/totp', { code: '000000' });
		expect(wrong.status).toBe(401);
		await wrong.text();
		expect((await sessionRecord(owner)).activationProof).toBeUndefined();
		const throttle = JSON.parse(await (await bucket().get('auth/throttle/totp.json'))!.text());
		expect(throttle.failureCount).toBe(1);
	});

	it('refuses a proof for a method that was never set up', async () => {
		const owner = await ownerSignIn();
		const response = await post(owner, '/api/auth/activate/totp', { code: '123456' });
		expect(response.status).toBe(403);
		await response.text();
	});

	it('the proof runs out after five minutes', async () => {
		const owner = await ownerSignIn();
		await configureTotp(SEED, false);
		await post(owner, '/api/auth/activate/totp', { code: await code() }).then((r) => r.text());
		await reauthPassword(owner);
		const { assertActivationProof } = await import('../src/worker/auth/sessions');
		const record = await sessionRecord(owner);
		const session = { key: '', sid: 'x', record };

		expect(() => assertActivationProof(session, record.activationProof.at + 299, 'totp')).not.toThrow();
		expect(() => assertActivationProof(session, record.activationProof.at + 300, 'totp')).toThrow();
	});

	it('a passkey proof works through its own options and verify', async () => {
		const authenticator = new VirtualAuthenticator(RP_ID, TEST_ORIGIN);
		const owner = await ownerSignIn();
		const credentialId = await enrollPasskey(owner, authenticator);

		const options = (await (await post(owner, '/api/auth/activate/passkey/options')).json()) as any;
		const verified = await post(owner, '/api/auth/activate/passkey/verify', {
			challenge: options.challenge,
			response: await authenticator.assert(options, credentialId),
		});
		expect(verified.status).toBe(200);
		await verified.text();
		expect((await sessionRecord(owner)).activationProof).toMatchObject({ method: 'passkey' });

		const toggled = await call(owner, 'PATCH', '/api/admin/security/methods', { method: 'passkey', enabled: true });
		expect(toggled.status).toBe(200);
		await toggled.text();
	});

	it('the same flow through the existing sign-in endpoints stays closed to a disabled method', async () => {
		await ownerSignIn();
		await configureTotp(SEED, false);
		const login = await testFetch(`${TEST_ORIGIN}/api/auth/login/totp`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Origin: TEST_ORIGIN },
			body: JSON.stringify({ code: await code(1) }),
		});
		expect(login.status).toBe(403);
		await login.text();
	});
});
