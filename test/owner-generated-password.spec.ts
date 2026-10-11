import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { env } from 'cloudflare:test';
import { resetStorage, testFetch, TEST_ORIGIN, TEST_JWT_SECRET } from './utils/test-setup';
import { createOwnerOnce, loadOwner, OWNER_KEY } from '../src/worker/auth/owner';
import { hashPassword } from '../src/worker/auth/password';
import { INITIAL_PASSWORD_KEY, BOOTSTRAP_MARKER_KEY } from '../src/worker/auth/bootstrap';

const bucket = () => env.R2_STORAGE;
const e = env as unknown as Record<string, unknown>;
const saved = { admin: e.ADMIN_BOOTSTRAP_PASSWORD, armed: e.SETUP_ARMED, enabled: e.BOOTSTRAP_ENABLED };

const methods = () => testFetch(`${TEST_ORIGIN}/api/auth/methods`);
const signIn = (password: string) =>
	testFetch(`${TEST_ORIGIN}/api/auth/login/password`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Origin: TEST_ORIGIN },
		body: JSON.stringify({ password }),
	});
const setupState = async () => ((await (await methods()).json()) as { setup: string }).setup;
const credential = async () => (await bucket().get(INITIAL_PASSWORD_KEY))?.text() ?? null;

describe('first setup with a generated owner password', () => {
	beforeEach(async () => {
		await resetStorage();
		e.ADMIN_BOOTSTRAP_PASSWORD = undefined;
		e.SETUP_ARMED = 'yes';
		e.BOOTSTRAP_ENABLED = 'true';
	});
	afterAll(() => {
		e.ADMIN_BOOTSTRAP_PASSWORD = saved.admin;
		e.SETUP_ARMED = saved.armed;
		e.BOOTSTRAP_ENABLED = saved.enabled;
	});

	it('makes a 43-character random password once, stores it privately, and the owner accepts it', async () => {
		expect(await setupState()).toBe('ready');
		const password = await credential();
		expect(password).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(await bucket().head('auth/owner.json')).not.toBeNull();

		const response = await signIn(password!);
		expect(response.status).toBe(200);
		await response.text();
		expect((await signIn('not-the-generated-password')).status).toBe(401);
	});

	it('never returns the generated password in any status or sign-in response', async () => {
		const methodsText = await (await methods()).text();
		const password = await credential();
		expect(methodsText).not.toContain(password!);
	});

	it('does nothing unless setup is armed by the deployer', async () => {
		e.SETUP_ARMED = undefined;
		expect(await setupState()).toBe('password-missing');
		expect(await bucket().head('auth/owner.json')).toBeNull();
		expect(await credential()).toBeNull();
	});

	it('does nothing when automatic setup is switched off', async () => {
		e.BOOTSTRAP_ENABLED = 'false';
		expect(await setupState()).toBe('password-missing');
		expect(await credential()).toBeNull();
	});

	it('concurrent requests yield one credential and one owner, and the owner matches that credential', async () => {
		await Promise.all(Array.from({ length: 8 }, () => setupState()));
		const listed = await bucket().list({ prefix: 'auth/' });
		expect(listed.objects.filter((o) => o.key === INITIAL_PASSWORD_KEY)).toHaveLength(1);
		expect(listed.objects.filter((o) => o.key === 'auth/owner.json')).toHaveLength(1);
		const response = await signIn((await credential())!);
		expect(response.status).toBe(200);
		await response.text();
	});

	it('an interrupted attempt that left the credential behind finishes with that same credential', async () => {
		await bucket().put(INITIAL_PASSWORD_KEY, 'Kx7pq2mzLw9Rt3vBnYc8Hd5Gf1Js6Qa0Ue4Ik2Mo7Pz', {});
		expect(await setupState()).toBe('ready');
		expect(await credential()).toBe('Kx7pq2mzLw9Rt3vBnYc8Hd5Gf1Js6Qa0Ue4Ik2Mo7Pz');
		const response = await signIn('Kx7pq2mzLw9Rt3vBnYc8Hd5Gf1Js6Qa0Ue4Ik2Mo7Pz');
		expect(response.status).toBe(200);
		await response.text();
	});

	it('a claimed marker with no owner: no new credential, no owner, no reset', async () => {
		await bucket().put(BOOTSTRAP_MARKER_KEY, new Date().toISOString(), {});
		expect(await setupState()).not.toBe('ready');
		expect(await credential()).toBeNull();
		expect(await bucket().head('auth/owner.json')).toBeNull();
	});

	it('an existing owner is never replaced and no credential is made for it', async () => {
		await createOwnerOnce(bucket(), 'the-existing-owner-password', TEST_JWT_SECRET);
		const before = await (await bucket().get('auth/owner.json'))!.text();
		expect(await setupState()).toBe('ready');
		expect(await (await bucket().get('auth/owner.json'))!.text()).toBe(before);
		expect(await credential()).toBeNull();
	});

	it('an older installation with its own setup secret keeps using that secret, and no credential is made', async () => {
		e.ADMIN_BOOTSTRAP_PASSWORD = 'legacy-setup-password-0123456789';
		expect(await setupState()).toBe('ready');
		expect(await credential()).toBeNull();
		const response = await signIn('legacy-setup-password-0123456789');
		expect(response.status).toBe(200);
		await response.text();
	});

	describe('retiring the initial credential', () => {
		// Stands in for the owner changing its password: the stored hash is replaced by one for another password
		async function changeOwnerPassword(to: string) {
			const loaded = (await loadOwner(bucket()))!;
			const owner = { ...loaded.owner, authVersion: loaded.owner.authVersion + 1 };
			owner.methods = { ...owner.methods, password: { ...owner.methods.password, hash: await hashPassword(to, TEST_JWT_SECRET) } };
			await bucket().put(OWNER_KEY, JSON.stringify(owner));
		}

		it('is kept while the owner still signs in with it', async () => {
			expect(await setupState()).toBe('ready');
			const password = (await credential())!;
			expect(await setupState()).toBe('ready');
			expect(await credential()).toBe(password);
		});

		it('is removed on the next status check after the owner password has changed', async () => {
			expect(await setupState()).toBe('ready');
			await changeOwnerPassword('a-brand-new-owner-password-2026');
			expect(await credential()).not.toBeNull();
			expect(await setupState()).toBe('ready');
			expect(await credential()).toBeNull();
			expect((await signIn('a-brand-new-owner-password-2026')).status).toBe(200);
		});

		it('a failed delete is retried later and never blocks sign-in', async () => {
			expect(await setupState()).toBe('ready');
			await changeOwnerPassword('a-brand-new-owner-password-2026');
			const real = bucket();
			let failed = false;
			e.R2_STORAGE = new Proxy(real, {
				get(target, property) {
					if (property === 'delete') {
						return (key: string) => {
							if (!failed) {
								failed = true;
								return Promise.reject(new Error('injected delete failure'));
							}
							return target.delete(key);
						};
					}
					const value = (target as any)[property];
					return typeof value === 'function' ? value.bind(target) : value;
				},
			}) as unknown as R2Bucket;
			try {
				expect(await setupState()).toBe('ready');
				expect(await credential()).not.toBeNull();
			} finally {
				e.R2_STORAGE = real as unknown as R2Bucket;
			}
			expect(await setupState()).toBe('ready');
			expect(await credential()).toBeNull();
		});
	});
});
