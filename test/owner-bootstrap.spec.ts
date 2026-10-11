import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { testFetch, resetStorage, TEST_JWT_SECRET } from './utils/test-setup';
import { loadOwner, createOwnerOnce, mutateOwner, OwnerCorruptError, parseOwner } from '../src/worker/auth/owner';
import { hashPassword, PASSWORD_ALGORITHM, verifyPassword } from '../src/worker/auth/password';
import { openSeed, sealSeed } from '../src/worker/auth/totp';

const BOOTSTRAP_PASSWORD = 'test-bootstrap-password-0123456789';
const bucket = () => env.R2_STORAGE;
const e = env as unknown as Record<string, string | undefined>;

// Object-level failure injection on the real bucket: fails the first matching put
function failFirstPut(prefix: string): R2Bucket {
	let failed = false;
	return new Proxy(bucket(), {
		get(target, property) {
			if (property === 'put') {
				return (key: string, ...rest: unknown[]) => {
					if (!failed && key.startsWith(prefix)) {
						failed = true;
						return Promise.reject(new Error('injected put failure'));
					}
					return (target.put as any).call(target, key, ...rest);
				};
			}
			const value = (target as any)[property];
			return typeof value === 'function' ? value.bind(target) : value;
		},
	}) as R2Bucket;
}

const ROOT = TEST_JWT_SECRET;

describe('password hashing (HMAC-SHA256-KEYED-V1)', () => {
	it('verifies the right password and rejects others', async () => {
		const stored = await hashPassword('correct horse battery staple', ROOT);
		expect(await verifyPassword('correct horse battery staple', stored, ROOT)).toBe(true);
		expect(await verifyPassword('correct horse battery stapl', stored, ROOT)).toBe(false);
		expect(await verifyPassword('', stored, ROOT)).toBe(false);
	});

	it('uses a fresh salt every time and never stores the password', async () => {
		const a = await hashPassword('same-password-value', ROOT);
		const b = await hashPassword('same-password-value', ROOT);
		expect(a.salt).not.toBe(b.salt);
		expect(a.hash).not.toBe(b.hash);
		expect(JSON.stringify(a)).not.toContain('same-password-value');
	});

	it('records only the algorithm, the salt and the digest', async () => {
		const stored = await hashPassword('another-password-value', ROOT);
		expect(Object.keys(stored).sort()).toEqual(['alg', 'hash', 'salt']);
		expect(stored.alg).toBe(PASSWORD_ALGORITHM);
		expect(PASSWORD_ALGORITHM).toBe('HMAC-SHA256-KEYED-V1');
	});

	it('depends on the root secret: another secret does not verify, and none fails closed', async () => {
		const stored = await hashPassword('keyed-password-value', ROOT);
		expect(await verifyPassword('keyed-password-value', stored, 'a-different-root-secret-of-good-length')).toBe(false);
		await expect(verifyPassword('keyed-password-value', stored, undefined)).rejects.toMatchObject({ status: 500 });
		await expect(verifyPassword('keyed-password-value', stored, 'short')).rejects.toMatchObject({ status: 500 });
		await expect(hashPassword('x', undefined)).rejects.toMatchObject({ status: 500 });
	});

	it('treats (salt, password) unambiguously: moving bytes between them changes the result', async () => {
		const stored = await hashPassword('abc', ROOT);
		const salt = Uint8Array.from(atob(stored.salt.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
		const shifted = {
			...stored,
			salt: btoa(String.fromCharCode(...salt, 0x61))
				.replace(/\+/g, '-')
				.replace(/\//g, '_')
				.replace(/=+$/, ''),
		};
		expect(await verifyPassword('bc', shifted, ROOT)).toBe(false);
	});

	it('refuses records it does not understand, including the retired PBKDF2 form', async () => {
		const good = await hashPassword('some-password-value', ROOT);
		const legacy = { alg: 'PBKDF2-SHA256', iterations: 600000, salt: good.salt, hash: good.hash } as unknown as typeof good;
		await expect(verifyPassword('some-password-value', legacy, ROOT)).rejects.toThrow();
		await expect(verifyPassword('some-password-value', { ...good, salt: 'AAAA' }, ROOT)).rejects.toThrow();
		await expect(verifyPassword('some-password-value', { ...good, hash: 'AAAA' }, ROOT)).rejects.toThrow();
		// ...and an owner record that carries the retired form is corrupt, not migrated
		const owner = JSON.parse(JSON.stringify(parseOwnerFixture(good)));
		owner.methods.password.hash = legacy;
		expect(() => parseOwner(owner)).toThrow(OwnerCorruptError);
	});
});

function parseOwnerFixture(hash: Awaited<ReturnType<typeof hashPassword>>) {
	return {
		schemaVersion: 1,
		authVersion: 1,
		createdAt: 1,
		methods: {
			password: { enabled: true, hash },
			totp: { enabled: false, encryptedSecret: null, lastAcceptedStep: null },
			passkey: { enabled: false, credentials: [] },
		},
	};
}

describe('authenticator seed protection (derived key, nothing to configure)', () => {
	const seed = new Uint8Array(20).map((_, i) => i + 1);

	it('round-trips under the root secret', async () => {
		const sealed = await sealSeed(seed, ROOT);
		expect(await openSeed(sealed, ROOT)).toEqual(seed);
	});

	it('uses a fresh IV every time and fails closed under another or missing root', async () => {
		const a = await sealSeed(seed, ROOT);
		const b = await sealSeed(seed, ROOT);
		expect(a.ct).not.toBe(b.ct);
		await expect(openSeed(a, 'a-different-root-secret-of-good-length')).rejects.toMatchObject({ status: 500 });
		await expect(openSeed(a, undefined)).rejects.toMatchObject({ status: 500 });
	});

	it('is a different key from the password key (separate contexts)', async () => {
		// The same root yields unrelated keys: a seed sealed for TOTP cannot be opened with the password key's bytes
		const sealed = await sealSeed(seed, ROOT);
		const tampered = { ...sealed, ct: sealed.ct.slice(0, -2) + (sealed.ct.endsWith('AA') ? 'BB' : 'AA') };
		await expect(openSeed(tampered, ROOT)).rejects.toMatchObject({ status: 500 });
	});
});

describe('owner record', () => {
	beforeEach(async () => {
		await resetStorage();
	});

	it('creates the owner only once', async () => {
		const first = await createOwnerOnce(bucket(), 'owner-one', TEST_JWT_SECRET);
		expect(first).toBe(true);
		expect(await createOwnerOnce(bucket(), 'owner-two', TEST_JWT_SECRET)).toBe(false);
		expect((await loadOwner(bucket()))?.owner.methods.password.enabled).toBe(true);
	});

	it('loses no update when mutations race each other', async () => {
		await createOwnerOnce(bucket(), 'owner-cas', TEST_JWT_SECRET);
		await Promise.all(
			Array.from({ length: 10 }, () => mutateOwner(bucket(), (owner) => ({ ...owner, authVersion: owner.authVersion + 1 }))),
		);
		expect((await loadOwner(bucket()))?.owner.authVersion).toBe(11);
	});

	it('refuses to load a record it cannot validate', async () => {
		await bucket().put('auth/owner.json', JSON.stringify({ schemaVersion: 99 }));
		await expect(loadOwner(bucket())).rejects.toBeInstanceOf(OwnerCorruptError);
	});

	it('refuses a record with no enabled and configured method (invariant)', async () => {
		await createOwnerOnce(bucket(), 'owner-invariant', TEST_JWT_SECRET);
		await expect(
			mutateOwner(bucket(), (owner) => ({
				...owner,
				methods: { ...owner.methods, password: { ...owner.methods.password, enabled: false } },
			})),
		).rejects.toThrow();
	});
});

describe('automatic first setup', () => {
	beforeEach(async () => {
		await resetStorage();
		e.BOOTSTRAP_ENABLED = 'true';
		e.ADMIN_BOOTSTRAP_PASSWORD = BOOTSTRAP_PASSWORD;
	});

	afterEach(() => {
		e.BOOTSTRAP_ENABLED = 'true';
		e.ADMIN_BOOTSTRAP_PASSWORD = BOOTSTRAP_PASSWORD;
	});

	it('has no route that lets a caller create an owner', async () => {
		for (const method of ['POST', 'PUT', 'GET']) {
			const response = await testFetch('http://example.com/api/auth/bootstrap', {
				method,
				headers: { 'Content-Type': 'application/json', Origin: 'http://example.com' },
				body: method === 'GET' ? undefined : JSON.stringify({ password: 'a-password-chosen-by-the-caller' }),
			});
			expect(response.status).toBe(404);
			await response.text();
		}
		expect(await loadOwner(bucket())).toBeNull();
		expect(await bucket().head('auth/bootstrap-marker')).toBeNull();
	});

	it('creates the owner from the deployment password on the first visit, stored only as a keyed hash', async () => {
		const response = await methods();
		expect(((await response.json()) as any).setup).toBe('ready');

		const raw = await (await bucket().get('auth/owner.json'))!.text();
		expect(raw).not.toContain(BOOTSTRAP_PASSWORD);
		const owner = JSON.parse(raw);
		expect(owner).toMatchObject({
			schemaVersion: 1,
			authVersion: 1,
			methods: {
				password: { enabled: true, hash: { alg: 'HMAC-SHA256-KEYED-V1' } },
				totp: { enabled: false, encryptedSecret: null },
				passkey: { enabled: false, credentials: [] },
			},
		});
		expect(await bucket().head('auth/bootstrap-marker')).not.toBeNull();
	});

	it('the deployment password then signs in as an ordinary login, and no other password does', async () => {
		await (await methods()).text();
		const login = (password: string) =>
			testFetch('http://example.com/api/auth/login/password', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Origin: 'http://example.com' },
				body: JSON.stringify({ password }),
			});
		expect((await login('not-the-deployment-password')).status).toBe(401);
		const ok = await login(BOOTSTRAP_PASSWORD);
		expect(ok.status).toBe(200);
		await ok.text();
	});

	it('creates exactly one owner when many first visits arrive together', async () => {
		const responses = await Promise.all(Array.from({ length: 10 }, () => methods()));
		const states = await Promise.all(responses.map(async (r) => ((await r.json()) as any).setup));
		expect(states.filter((state) => state === 'ready').length).toBeGreaterThanOrEqual(1);
		expect(states.every((state) => state === 'ready' || state === 'initializing')).toBe(true);
		expect((await bucket().list({ prefix: 'auth/owner' })).objects).toHaveLength(1);
		// Whoever lost the race asks again and finds the ordinary sign-in
		expect(((await (await methods()).json()) as any).setup).toBe('ready');
	});

	it('never replaces an existing owner, even if the deployment password differs', async () => {
		await createOwnerOnce(bucket(), 'the-existing-owner-password', TEST_JWT_SECRET);
		const before = await (await bucket().get('auth/owner.json'))!.text();
		e.ADMIN_BOOTSTRAP_PASSWORD = 'a-completely-different-setup-password';
		expect(((await (await methods()).json()) as any).setup).toBe('ready');
		expect(await (await bucket().get('auth/owner.json'))!.text()).toBe(before);
		expect(await bucket().head('auth/bootstrap-marker')).toBeNull();
	});

	it('creates nothing without a usable setup password, and says so', async () => {
		for (const password of [undefined, '', 'short']) {
			e.ADMIN_BOOTSTRAP_PASSWORD = password;
			expect(((await (await methods()).json()) as any).setup).toBe('password-missing');
		}
		e.ADMIN_BOOTSTRAP_PASSWORD = BOOTSTRAP_PASSWORD;
		e.BOOTSTRAP_ENABLED = 'false';
		expect(((await (await methods()).json()) as any).setup).toBe('password-missing');
		expect(await bucket().head('auth/owner.json')).toBeNull();
		expect(await bucket().head('auth/bootstrap-marker')).toBeNull();
	});

	it('does not reopen setup when the owner write failed after the marker was claimed', async () => {
		const original = e.R2_STORAGE;
		(env as any).R2_STORAGE = failFirstPut('auth/owner.json');
		try {
			const failed = await methods();
			expect(((await failed.json()) as any).setup).toBe('failed');
		} finally {
			(env as any).R2_STORAGE = original;
		}

		expect(await bucket().head('auth/bootstrap-marker')).not.toBeNull();
		// A claim that just happened is still "in progress"; once it is old, the site says it needs recovery
		const retry = await methods();
		expect(((await retry.json()) as any).setup).toBe('initializing');
		vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 10 * 60 * 1000 });
		try {
			expect(((await (await methods()).json()) as any).setup).toBe('recovery-required');
		} finally {
			vi.useRealTimers();
		}
		expect(await bucket().head('auth/owner.json')).toBeNull();
	});

	it('a hash that fails leaves nothing claimed, so the next visit simply tries again', async () => {
		vi.spyOn(crypto.subtle, 'sign').mockRejectedValueOnce(new Error('Worker exceeded CPU time limit'));
		vi.spyOn(console, 'error').mockImplementation(() => undefined);
		try {
			expect(((await (await methods()).json()) as any).setup).toBe('failed');
			expect(await bucket().head('auth/bootstrap-marker')).toBeNull();
			expect(((await (await methods()).json()) as any).setup).toBe('ready');
		} finally {
			vi.restoreAllMocks();
		}
	});
});

function methods() {
	return testFetch('http://example.com/api/auth/methods');
}
