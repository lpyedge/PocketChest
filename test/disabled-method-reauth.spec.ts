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
	// The first passkey switches the method on and replaces the session: carry on with the new cookie, and switch the
	// method off again, since these tests are about a method that is off
	const cookie = (verify.headers.get('Set-Cookie') ?? '').split(';')[0];
	const data = (await verify.json()) as any;
	if (cookie) {
		owner.cookie = cookie;
		owner.csrfToken = data.csrfToken;
	}
	await mutateOwner(bucket(), (record) => ({
		...record,
		methods: { ...record.methods, passkey: { ...record.methods.passkey, enabled: false } },
	}));
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
		// The authenticator confirms the owner, so the password may be the one switched off
		expect((await post(first, '/api/auth/reauth/totp', { code: await code() })).status).toBe(200);

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
		expect((await post(owner, '/api/auth/reauth/totp', { code: await code() })).status).toBe(200);

		const [toggle, reentry] = await Promise.all([
			call(owner, 'PATCH', '/api/admin/security/methods', { method: 'password', enabled: false }),
			post(owner, '/api/auth/reauth/password', { password: TEST_OWNER_PASSWORD }),
		]);
		const toggleStatus = toggle.status;
		await toggle.text();
		await reentry.text();

		// Either the switch-off won, or the password re-entry replaced the confirming method first and the change was refused
		expect([200, 403]).toContain(toggleStatus);
		if (toggleStatus === 200) {
			// Whatever the order, the password is off, and nobody can re-enter with it
			expect((await ownerRecord()).methods.password.enabled).toBe(false);
			const after = await post(owner, '/api/auth/reauth/password', { password: TEST_OWNER_PASSWORD });
			expect([401, 403]).toContain(after.status);
			await after.text();
		} else {
			expect((await ownerRecord()).methods.password.enabled).toBe(true);
		}
	});
});

describe('N2-03 switching a method back on', () => {
	beforeEach(async () => {
		await resetStorage();
		await setupTestEnvironment();
	});

	it('needs only a re-entry with a method that is on, not a proof of the method being switched on', async () => {
		const owner = await ownerSignIn();
		await configureTotp(SEED, false);
		await reauthPassword(owner);

		const toggled = await call(owner, 'PATCH', '/api/admin/security/methods', { method: 'totp', enabled: true });

		expect(toggled.status).toBe(200);
		await toggled.text();
		expect((await ownerRecord()).methods.totp.enabled).toBe(true);
	});

	it('is still refused without a recent re-entry', async () => {
		const owner = await ownerSignIn();
		await configureTotp(SEED, false);

		const response = await call(owner, 'PATCH', '/api/admin/security/methods', { method: 'totp', enabled: true });

		expect(response.status).toBe(403);
		expect(await codeOf(response)).toBe('REAUTH_REQUIRED');
	});

	it('has no separate proof step any more', async () => {
		const owner = await ownerSignIn();
		await configureTotp(SEED, false);
		const response = await post(owner, '/api/auth/activate/totp', { code: await code() });
		expect(response.status).toBe(404);
		await response.text();
	});

	it('the sign-in endpoints stay closed to a method that is off', async () => {
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
