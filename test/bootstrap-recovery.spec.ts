import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadOwner, createOwnerOnce } from '../src/worker/auth/owner';
import { resetStorage, testFetch, TEST_ORIGIN, TEST_JWT_SECRET } from './utils/test-setup';
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
		vi.spyOn(crypto.subtle, 'sign').mockRejectedValueOnce(new Error('Worker exceeded CPU time limit'));
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
function storage(overrides: { ownerAppearsAfterMarkerCheck?: boolean } = {}) {
	const cleared: string[] = [];
	return {
		cleared,
		async hasMarker() {
			return (await bucket().head(MARKER)) !== null;
		},
		async readOwner() {
			const object = await bucket().get('auth/owner.json');
			return object ? { body: await object.text() } : null;
		},
		async clearMarker() {
			cleared.push(MARKER);
			if (overrides.ownerAppearsAfterMarkerCheck) await createOwnerOnce(bucket(), 'someone-else-just-made-this', TEST_JWT_SECRET);
			await bucket().delete(MARKER);
		},
	};
}

describe('F-02 offline recovery of an interrupted first setup', () => {
	beforeEach(async () => {
		await resetStorage();
	});

	it('removes only the marker when the marker exists and the owner does not, creating nothing', async () => {
		await bucket().put(MARKER, new Date().toISOString());
		await bucket().put('codes/ABC123', 'shared-data-untouched');
		const store = storage();

		const result = await core.recoverBootstrap(store);

		expect(result).toEqual({ markerCleared: true });
		expect(await bucket().head(MARKER)).toBeNull();
		expect(await loadOwner(bucket())).toBeNull();
		expect(await (await bucket().get('codes/ABC123'))!.text()).toBe('shared-data-untouched');
	});

	it('setup can then run again with the deployment setup password, and only with it', async () => {
		await bucket().put(MARKER, 'claimed');
		await core.recoverBootstrap(storage());
		e.BOOTSTRAP_ENABLED = 'true';
		e.ADMIN_BOOTSTRAP_PASSWORD = SETUP;

		expect((await bootstrap('not-the-setup-password-000000')).status).toBe(401);
		const ok = await bootstrap(SETUP);
		expect(ok.status).toBe(201);
		await ok.text();
		expect(await loadOwner(bucket())).not.toBeNull();
	});

	it('does nothing when setup is not stuck, because the marker was never claimed', async () => {
		const store = storage();
		await expect(core.recoverBootstrap(store)).rejects.toThrow(/not interrupted|no setup marker|still open/i);
		expect(store.cleared).toEqual([]);
		expect(await loadOwner(bucket())).toBeNull();
	});

	it('does nothing when an owner already exists: the marker stays', async () => {
		await bucket().put(MARKER, 'claimed');
		await createOwnerOnce(bucket(), 'the-existing-owner-password', TEST_JWT_SECRET);
		const before = await (await bucket().get('auth/owner.json'))!.text();
		const store = storage();

		await expect(core.recoverBootstrap(store)).rejects.toThrow(/owner already exists/);

		expect(store.cleared).toEqual([]);
		expect(await bucket().head(MARKER)).not.toBeNull();
		expect(await (await bucket().get('auth/owner.json'))!.text()).toBe(before);
	});

	it('reports it when an owner appears while the marker is being removed', async () => {
		await bucket().put(MARKER, 'claimed');
		await expect(core.recoverBootstrap(storage({ ownerAppearsAfterMarkerCheck: true }))).rejects.toThrow(/appeared|verified/i);
		expect(await loadOwner(bucket())).not.toBeNull();
	});
});
