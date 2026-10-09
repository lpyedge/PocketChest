import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import worker from '../src/worker/index';
import {
	objectText,
	ownerRecord,
	ownerSignIn,
	resetStorage,
	setupTestEnvironment,
	testFetch,
	TEST_ORIGIN,
	TEST_OWNER_PASSWORD,
} from './utils/test-setup';
import { VirtualAuthenticator } from './utils/virtual-authenticator';
import { mutateOwner } from '../src/worker/auth/owner';
import { CHALLENGE_PREFIX } from '../src/worker/auth/challenges';
import { sessionKey, sha256Hex } from '../src/worker/auth/sessions';
import type { Env } from '../src/worker/types';

const bucket = () => env.R2_STORAGE;
const RP_ID = new URL(TEST_ORIGIN).hostname;

type Owner = Awaited<ReturnType<typeof ownerSignIn>>;

function post(path: string, body: unknown, headers: Record<string, string> = {}, environment?: Env) {
	const init = {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Origin: TEST_ORIGIN, ...headers },
		body: JSON.stringify(body),
	};
	if (environment) {
		const ctx = createExecutionContext();
		return worker.fetch(new Request(`${TEST_ORIGIN}${path}`, init), environment, ctx).then(async (response) => {
			await waitOnExecutionContext(ctx);
			return response;
		});
	}
	return testFetch(`${TEST_ORIGIN}${path}`, init);
}

function signedIn(owner: Owner) {
	return { Cookie: owner.cookie, 'X-PocketChest-CSRF': owner.csrfToken };
}

// Registers one passkey with the owner through the real endpoints
async function enrollPasskey(owner: Owner, authenticator: VirtualAuthenticator): Promise<string> {
	const reauth = await post('/api/auth/reauth/password', { password: TEST_OWNER_PASSWORD }, signedIn(owner));
	await reauth.text();
	const options = (await (await post('/api/admin/passkeys/register/options', {}, signedIn(owner))).json()) as any;
	const response = await authenticator.register(options);
	const verify = await post(
		'/api/admin/passkeys/register/verify',
		{ challenge: options.challenge, response, label: 'Test key' },
		signedIn(owner),
	);
	expect(verify.status).toBe(200);
	await verify.text();
	return response.id;
}

// Sets which methods are on. Enrolling a passkey does not switch it on; this is how a test does that.
async function setPasskeyState(passkeyEnabled: boolean, passwordEnabled: boolean, keepCredentials = true) {
	await mutateOwner(bucket(), (owner) => ({
		...owner,
		methods: {
			password: { ...owner.methods.password, enabled: passwordEnabled },
			totp: owner.methods.totp,
			passkey: {
				...owner.methods.passkey,
				enabled: passkeyEnabled,
				credentials: keepCredentials ? owner.methods.passkey.credentials : [],
			},
		},
	}));
}

async function loginOptions(): Promise<any> {
	const response = await post('/api/auth/passkey/login/options', {});
	expect(response.status).toBe(200);
	return response.json();
}

async function loginVerify(challenge: string, response: unknown, environment?: Env) {
	return post('/api/auth/passkey/login/verify', { challenge, response }, {}, environment);
}

async function passkeyRecord(credentialId: string) {
	const owner = await ownerRecord();
	return owner.methods.passkey.credentials.find((credential) => credential.id === credentialId);
}

describe('passkey sign-in', () => {
	let authenticator: VirtualAuthenticator;
	let credentialId: string;

	beforeAll(async () => {
		await resetStorage();
	});

	beforeEach(async () => {
		await setupTestEnvironment();
		authenticator = new VirtualAuthenticator(RP_ID, TEST_ORIGIN);
		const owner = await ownerSignIn();
		credentialId = await enrollPasskey(owner, authenticator);
		// Passkey only: the password is switched off, and the passkey is switched on
		await setPasskeyState(true, false);
	});

	it('signs the owner in with a passkey alone, when the password is switched off', async () => {
		const options = await loginOptions();
		expect(options.allowCredentials.map((item: { id: string }) => item.id)).toEqual([credentialId]);

		const response = await loginVerify(options.challenge, await authenticator.assert(options, credentialId));
		expect(response.status).toBe(200);
		const cookie = (response.headers.get('Set-Cookie') ?? '').split(';')[0];
		expect(cookie).toMatch(/^__Host-pc_owner=/);
		const data = (await response.json()) as any;
		expect(typeof data.csrfToken).toBe('string');

		const status = await testFetch(`${TEST_ORIGIN}/api/auth/session`, { headers: { Cookie: cookie } });
		expect(await status.json()).toMatchObject({ authenticated: true });
	});

	it('advances the stored counter and records when the passkey was last used', async () => {
		const options = await loginOptions();
		await (await loginVerify(options.challenge, await authenticator.assert(options, credentialId))).text();

		const record = await passkeyRecord(credentialId);
		expect(record?.counter).toBe(1);
		expect(typeof record?.lastUsedAt).toBe('number');
	});

	it('never lowers the counter when another sign-in commits a newer one first (FIX-07)', async () => {
		const options = await loginOptions();
		const older = await authenticator.assert(options, credentialId); // counter 1

		// While this assertion is being stored, a concurrent sign-in commits counter 11 for the same key
		let injected = false;
		const racing = new Proxy(bucket(), {
			get(target, property) {
				if (property === 'put') {
					return async (key: string, ...rest: unknown[]) => {
						if (!injected && key === 'auth/owner.json') {
							injected = true;
							await mutateOwner(target, (owner) => ({
								...owner,
								methods: {
									...owner.methods,
									passkey: {
										...owner.methods.passkey,
										credentials: owner.methods.passkey.credentials.map((credential) => ({ ...credential, counter: 11 })),
									},
								},
							}));
						}
						return (target.put as any).call(target, key, ...rest);
					};
				}
				const value = (target as any)[property];
				return typeof value === 'function' ? value.bind(target) : value;
			},
		}) as R2Bucket;

		const response = await loginVerify(options.challenge, older, { ...env, R2_STORAGE: racing } as unknown as Env);

		expect(injected).toBe(true);
		expect(response.status).toBe(401);
		expect(response.headers.get('Set-Cookie')).toBeNull();
		await response.text();
		expect((await passkeyRecord(credentialId))?.counter).toBe(11);
	});

	it('does not accept the same challenge twice', async () => {
		const options = await loginOptions();
		const assertion = await authenticator.assert(options, credentialId);
		const first = await loginVerify(options.challenge, assertion);
		expect(first.status).toBe(200);
		await first.text();

		const replay = await loginVerify(options.challenge, await authenticator.assert(options, credentialId));
		expect(replay.status).toBe(400);
		expect(((await replay.json()) as any).code).toBe('CHALLENGE_INVALID');
	});

	it('refuses an assertion made for another origin', async () => {
		const options = await loginOptions();
		const response = await loginVerify(
			options.challenge,
			await authenticator.assert(options, credentialId, { origin: 'https://evil.example' }),
		);
		expect(response.status).toBe(401);
		expect(response.headers.get('Set-Cookie')).toBeNull();
		await response.text();
	});

	it('refuses an assertion made for another RP ID', async () => {
		const options = await loginOptions();
		const response = await loginVerify(options.challenge, await authenticator.assert(options, credentialId, { rpId: 'other.example' }));
		expect(response.status).toBe(401);
		await response.text();
	});

	it('refuses a credential the owner did not register', async () => {
		// A key the owner never registered, made by some other authenticator
		const stranger = new VirtualAuthenticator(RP_ID, TEST_ORIGIN);
		const unknown = await stranger.register({ challenge: 'x'.repeat(43) });
		const options = await loginOptions();
		const response = await loginVerify(options.challenge, await stranger.assert(options, unknown.id));
		expect(response.status).toBe(401);
		await response.text();
	});

	it('refuses a passkey whose method has been switched off', async () => {
		const options = await loginOptions();
		const assertion = await authenticator.assert(options, credentialId);
		await setPasskeyState(false, true);

		const refusedOptions = await post('/api/auth/passkey/login/options', {});
		expect(refusedOptions.status).toBe(403);
		await refusedOptions.text();
		const response = await loginVerify(options.challenge, assertion);
		expect(response.status).toBe(401);
		await response.text();
	});

	it('refuses a valid assertion once the passkey has been removed', async () => {
		const options = await loginOptions();
		const assertion = await authenticator.assert(options, credentialId);
		await setPasskeyState(true, true, false);
		const response = await loginVerify(options.challenge, assertion);
		expect(response.status).toBe(401);
		await response.text();
	});

	it('issues no session for a sign-in that is started but never finished', async () => {
		const before = (await bucket().list({ prefix: 'auth/sessions/' })).objects.length;
		await loginOptions();
		expect((await bucket().list({ prefix: 'auth/sessions/' })).objects.length).toBe(before);
		expect((await bucket().list({ prefix: CHALLENGE_PREFIX })).objects.length).toBeGreaterThan(0);
	});

	it('is refused by the rate limit before a challenge is created', async () => {
		const refusing = { limit: async () => ({ success: false }) };
		const response = await post('/api/auth/passkey/login/options', {}, {}, { ...env, AUTH_LIMITER: refusing } as unknown as Env);
		expect(response.status).toBe(429);
		await response.text();
	});

	it('is refused by the rate limit on verify without using the challenge', async () => {
		const options = await loginOptions();
		const assertion = await authenticator.assert(options, credentialId);
		const refusing = { limit: async () => ({ success: false }) };
		const limited = await loginVerify(options.challenge, assertion, { ...env, AUTH_LIMITER: refusing } as unknown as Env);
		expect(limited.status).toBe(429);
		await limited.text();

		// The challenge is still valid after the refusal
		const accepted = await loginVerify(options.challenge, assertion);
		expect(accepted.status).toBe(200);
		await accepted.text();
	});
});

describe('passkey re-entry', () => {
	beforeAll(async () => {
		await resetStorage();
	});

	beforeEach(async () => {
		await setupTestEnvironment();
	});

	it('opens the reauth window for the current session with a passkey, and not for another session', async () => {
		const authenticator = new VirtualAuthenticator(RP_ID, TEST_ORIGIN);
		const owner = await ownerSignIn();
		const credentialId = await enrollPasskey(owner, authenticator);
		await setPasskeyState(true, true);

		const options = (await (await post('/api/auth/reauth/passkey/options', {}, signedIn(owner))).json()) as any;

		// A challenge issued to one session cannot re-enter a different session, and is not used up by the attempt
		const other = await ownerSignIn();
		const foreign = await post(
			'/api/auth/reauth/passkey/verify',
			{ challenge: options.challenge, response: await authenticator.assert(options, credentialId) },
			signedIn(other),
		);
		expect(foreign.status).toBe(400);
		await foreign.text();

		const verified = await post(
			'/api/auth/reauth/passkey/verify',
			{ challenge: options.challenge, response: await authenticator.assert(options, credentialId) },
			signedIn(owner),
		);
		expect(verified.status).toBe(200);
		await verified.text();

		const sid = owner.cookie.split('=')[1];
		const stored = await bucket().get(sessionKey(await sha256Hex(sid)));
		if (!stored) {
			throw new Error('Session record missing');
		}
		expect(JSON.parse(await stored.text()).reauthenticatedAt).toEqual(expect.any(Number));
	});

	it('requires a signed-in session', async () => {
		const response = await post('/api/auth/reauth/passkey/options', {});
		expect(response.status).toBe(401);
		await response.text();
	});
});
