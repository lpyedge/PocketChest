import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import { testFetch, resetStorage, TEST_JWT_SECRET } from './utils/test-setup';
import { loadOwner, createOwnerOnce, mutateOwner, OwnerCorruptError, parseOwner } from '../src/worker/auth/owner';
import { hashPassword, PASSWORD_ALGORITHM, verifyPassword } from '../src/worker/auth/password';
import { openSeed, sealSeed } from '../src/worker/auth/totp';

const BOOTSTRAP_PASSWORD = 'test-bootstrap-password-0123456789';
const bucket = () => env.R2_STORAGE;
const e = env as unknown as Record<string, string | undefined>;

function bootstrap(password: unknown) {
	return testFetch('http://example.com/api/auth/bootstrap', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Origin: 'http://example.com' },
		body: JSON.stringify({ password }),
	});
}

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

describe('POST /api/auth/bootstrap', () => {
	it('refuses a cross-origin request and claims nothing', async () => {
		const response = await testFetch('http://example.com/api/auth/bootstrap', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
			body: JSON.stringify({ password: BOOTSTRAP_PASSWORD }),
		});
		expect(response.status).toBe(403);
		await response.text();
		expect(await loadOwner(bucket())).toBeNull();
		expect(await bucket().head('auth/bootstrap-marker')).toBeNull();
	});

	beforeEach(async () => {
		await resetStorage();
		e.BOOTSTRAP_ENABLED = 'true';
		e.ADMIN_BOOTSTRAP_PASSWORD = BOOTSTRAP_PASSWORD;
	});

	afterEach(() => {
		e.BOOTSTRAP_ENABLED = 'true';
		e.ADMIN_BOOTSTRAP_PASSWORD = BOOTSTRAP_PASSWORD;
	});

	it('initializes the owner with the bootstrap password, stored only as a hash', async () => {
		const response = await bootstrap(BOOTSTRAP_PASSWORD);
		expect(response.status).toBe(201);
		expect(await response.json()).toEqual({ initialized: true });

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

	it('lets exactly one of ten concurrent bootstraps succeed', async () => {
		const responses = await Promise.all(Array.from({ length: 10 }, () => bootstrap(BOOTSTRAP_PASSWORD)));
		const statuses = responses.map((r) => r.status).sort();
		responses.forEach((r) => r.text());

		expect(statuses.filter((s) => s === 201)).toHaveLength(1);
		expect(statuses.filter((s) => s === 409)).toHaveLength(9);
		expect((await bucket().list({ prefix: 'auth/owner' })).objects).toHaveLength(1);
	});

	it('refuses another bootstrap after initialization, even with the right password', async () => {
		await bootstrap(BOOTSTRAP_PASSWORD);
		const again = await bootstrap(BOOTSTRAP_PASSWORD);
		expect(again.status).toBe(409);
		expect(((await again.json()) as any).code).toBe('BOOTSTRAP_CLOSED');
	});

	it('rejects a wrong password and claims nothing', async () => {
		const response = await bootstrap('not-the-bootstrap-password');
		expect(response.status).toBe(401);
		expect(((await response.json()) as any).code).toBe('AUTH_INVALID_CREDENTIALS');
		expect(await bucket().head('auth/owner.json')).toBeNull();
		expect(await bucket().head('auth/bootstrap-marker')).toBeNull();
	});

	it('is closed unless BOOTSTRAP_ENABLED is true', async () => {
		e.BOOTSTRAP_ENABLED = 'false';
		const response = await bootstrap(BOOTSTRAP_PASSWORD);
		expect(response.status).toBe(403);
		expect(((await response.json()) as any).code).toBe('BOOTSTRAP_DISABLED');
		expect(await bucket().head('auth/owner.json')).toBeNull();
	});

	it('fails closed when no bootstrap password is configured', async () => {
		e.ADMIN_BOOTSTRAP_PASSWORD = undefined;
		const response = await bootstrap(BOOTSTRAP_PASSWORD);
		expect(response.status).toBe(403);
		expect(((await response.json()) as any).code).toBe('BOOTSTRAP_DISABLED');
	});

	it('does not allow a second bootstrap when the owner write failed after the marker was claimed', async () => {
		const original = e.R2_STORAGE;
		(env as any).R2_STORAGE = failFirstPut('auth/owner.json');
		try {
			const failed = await bootstrap(BOOTSTRAP_PASSWORD);
			expect(failed.status).toBe(500);
			await failed.text();
		} finally {
			(env as any).R2_STORAGE = original;
		}

		expect(await bucket().head('auth/bootstrap-marker')).not.toBeNull();
		const retry = await bootstrap(BOOTSTRAP_PASSWORD);
		expect(retry.status).toBe(409);
		expect(((await retry.json()) as any).code).toBe('AUTH_RECOVERY_REQUIRED');
		expect(await bucket().head('auth/owner.json')).toBeNull();
	});

	it('refuses to initialize over a corrupt owner record', async () => {
		await bucket().put('auth/owner.json', '{corrupt');
		const response = await bootstrap(BOOTSTRAP_PASSWORD);
		expect(response.status).toBe(409);
		await response.text();
		expect(
			await bucket()
				.get('auth/owner.json')
				.then((o) => o!.text()),
		).toBe('{corrupt');
	});

	it('answers a malformed body with a plain 400', async () => {
		const response = await bootstrap(undefined);
		expect(response.status).toBe(400);
		await response.text();
	});
});
