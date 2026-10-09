import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadOwner, createOwnerOnce } from '../src/worker/auth/owner';
import { verifyPassword } from '../src/worker/auth/password';
import { resetStorage, testFetch, TEST_ORIGIN } from './utils/test-setup';
import * as core from '../scripts/recovery-core.mjs';

const original = env.R2_STORAGE;
const bucket = () => original;
const e = env as unknown as Record<string, unknown>;
const SETUP = 'test-bootstrap-password-0123456789';
const NEW_PASSWORD = 'first-owner-passphrase-2026';
const MARKER = 'auth/bootstrap-marker';

const bootstrap = (password = SETUP) =>
	testFetch(`${TEST_ORIGIN}/api/auth/bootstrap`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Origin: TEST_ORIGIN },
		body: JSON.stringify({ password }),
	});

function failingOwnerWrite(): R2Bucket {
	return new Proxy(original, {
		get(target, property) {
			if (property === 'put') {
				return (key: string, ...rest: unknown[]) =>
					key === 'auth/owner.json' ? Promise.reject(new Error('injected put failure')) : (target.put as any).call(target, key, ...rest);
			}
			const value = (target as any)[property];
			return typeof value === 'function' ? value.bind(target) : value;
		},
	}) as R2Bucket;
}

describe('F-02 first setup does the expensive work before it claims the marker', () => {
	beforeEach(async () => {
		await resetStorage();
		e.BOOTSTRAP_ENABLED = 'true';
		e.ADMIN_BOOTSTRAP_PASSWORD = SETUP;
	});
	afterEach(() => {
		vi.restoreAllMocks();
		Object.defineProperty(env, 'R2_STORAGE', { value: original, configurable: true });
	});

	it('a hash that fails (for example for lack of CPU) leaves no marker, so setup can simply be tried again', async () => {
		vi.spyOn(crypto.subtle, 'deriveBits').mockRejectedValueOnce(new Error('Worker exceeded CPU time limit'));
		vi.spyOn(console, 'error').mockImplementation(() => undefined);

		const failed = await bootstrap();
		expect(failed.status).toBe(500);
		await failed.text();
		expect(await bucket().head(MARKER)).toBeNull();
		expect(await loadOwner(bucket())).toBeNull();

		const retry = await bootstrap();
		expect(retry.status).toBe(201);
		await retry.text();
		expect(await loadOwner(bucket())).not.toBeNull();
	});

	it('a write of the owner that fails after the marker was claimed leaves the state the recovery tool expects', async () => {
		Object.defineProperty(env, 'R2_STORAGE', { value: failingOwnerWrite(), configurable: true });
		vi.spyOn(console, 'error').mockImplementation(() => undefined);

		const failed = await bootstrap();
		expect(failed.status).toBe(500);
		await failed.text();
		Object.defineProperty(env, 'R2_STORAGE', { value: original, configurable: true });

		expect(await bucket().head(MARKER)).not.toBeNull();
		expect(await loadOwner(bucket())).toBeNull();
		// The website does not reopen setup by itself; it says the administrator has to recover it
		const again = await bootstrap();
		expect(again.status).toBe(409);
		expect(((await again.json()) as any).code).toBe('AUTH_RECOVERY_REQUIRED');
	});
});

// The storage the offline tool is given: the Worker's own bucket, standing in for wrangler's management interface
function storage(overrides: { ownerAppearsBeforeWrite?: boolean; corruptWrite?: boolean } = {}) {
	const writes: string[] = [];
	let ownerReads = 0;
	return {
		writes,
		async hasMarker() {
			return (await bucket().head(MARKER)) !== null;
		},
		async readOwner() {
			ownerReads++;
			if (overrides.ownerAppearsBeforeWrite && ownerReads === 2) await createOwnerOnce(bucket(), 'someone-else-just-made-this');
			const object = await bucket().get('auth/owner.json');
			return object ? { body: await object.text() } : null;
		},
		async writeOwner(body: string) {
			writes.push(body);
			await bucket().put('auth/owner.json', overrides.corruptWrite ? '{"broken":' : body);
		},
	};
}

describe('F-02 offline recovery of an interrupted first setup', () => {
	beforeEach(async () => {
		await resetStorage();
	});

	it('creates the first owner when the marker exists and the owner does not', async () => {
		await bucket().put(MARKER, new Date().toISOString());
		const store = storage();

		const result = await core.recoverBootstrap(store, NEW_PASSWORD);

		expect(result.authVersion).toBe(1);
		const loaded = await loadOwner(bucket());
		expect(loaded?.owner.methods.password.enabled).toBe(true);
		expect(await verifyPassword(NEW_PASSWORD, loaded!.owner.methods.password.hash!)).toBe(true);
		// The marker is left exactly as it was: setup does not reopen
		expect(await bucket().head(MARKER)).not.toBeNull();
	});

	it('makes a record the Worker accepts for signing in', async () => {
		await bucket().put(MARKER, 'claimed');
		await core.recoverBootstrap(storage(), NEW_PASSWORD);

		const login = await testFetch(`${TEST_ORIGIN}/api/auth/login/password`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Origin: TEST_ORIGIN },
			body: JSON.stringify({ password: NEW_PASSWORD }),
		});
		expect(login.status).toBe(200);
		await login.text();
	});

	it('writes the same record shape as the Worker does on first setup', async () => {
		await createOwnerOnce(bucket(), 'some-owner-password');
		const fromWorker = JSON.parse(await (await bucket().get('auth/owner.json'))!.text());
		await resetStorage();
		await bucket().put(MARKER, 'claimed');
		await core.recoverBootstrap(storage(), NEW_PASSWORD);
		const fromTool = JSON.parse(await (await bucket().get('auth/owner.json'))!.text());

		const shape = (value: unknown): unknown =>
			value !== null && typeof value === 'object' && !Array.isArray(value)
				? Object.fromEntries(
						Object.keys(value)
							.sort()
							.map((k) => [k, shape((value as any)[k])]),
					)
				: Array.isArray(value)
					? []
					: typeof value;
		expect(shape(fromTool)).toEqual(shape(fromWorker));
	});

	it('does nothing when setup is not stuck, because the marker was never claimed', async () => {
		const store = storage();
		await expect(core.recoverBootstrap(store, NEW_PASSWORD)).rejects.toThrow(/not interrupted|no setup marker|still open/i);
		expect(store.writes).toEqual([]);
		expect(await loadOwner(bucket())).toBeNull();
	});

	it('does nothing when an owner already exists, and points at the password tool', async () => {
		await bucket().put(MARKER, 'claimed');
		await createOwnerOnce(bucket(), 'the-existing-owner-password');
		const before = await (await bucket().get('auth/owner.json'))!.text();
		const store = storage();

		await expect(core.recoverBootstrap(store, NEW_PASSWORD)).rejects.toThrow(/reset-owner-password/);

		expect(store.writes).toEqual([]);
		expect(await (await bucket().get('auth/owner.json'))!.text()).toBe(before);
	});

	it('refuses a short password before touching anything', async () => {
		await bucket().put(MARKER, 'claimed');
		const store = storage();
		await expect(core.recoverBootstrap(store, 'short')).rejects.toThrow(/at least 16/);
		expect(store.writes).toEqual([]);
	});

	it('does not overwrite an owner that appears while the password is being hashed', async () => {
		await bucket().put(MARKER, 'claimed');
		const store = storage({ ownerAppearsBeforeWrite: true });

		await expect(core.recoverBootstrap(store, NEW_PASSWORD)).rejects.toThrow(/appeared|changed/i);

		expect(store.writes).toEqual([]);
		const loaded = await loadOwner(bucket());
		expect(await verifyPassword('someone-else-just-made-this', loaded!.owner.methods.password.hash!)).toBe(true);
	});

	it('reports a write that cannot be read back as the record it wrote', async () => {
		await bucket().put(MARKER, 'claimed');
		await expect(core.recoverBootstrap(storage({ corruptWrite: true }), NEW_PASSWORD)).rejects.toThrow(/verif|read back/i);
	});
});
