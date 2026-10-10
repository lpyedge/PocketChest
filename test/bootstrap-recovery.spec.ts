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

	it('setup then runs again by itself with the deployment setup password', async () => {
		await bucket().put(MARKER, 'claimed');
		await core.recoverBootstrap(storage());
		e.BOOTSTRAP_ENABLED = 'true';
		e.ADMIN_BOOTSTRAP_PASSWORD = SETUP;

		const methods = (await (await testFetch(`${TEST_ORIGIN}/api/auth/methods`)).json()) as any;
		expect(methods.setup).toBe('ready');
		const login = (password: string) =>
			testFetch(`${TEST_ORIGIN}/api/auth/login/password`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', Origin: TEST_ORIGIN },
				body: JSON.stringify({ password }),
			});
		expect((await login('not-the-setup-password-000000')).status).toBe(401);
		const ok = await login(SETUP);
		expect(ok.status).toBe(200);
		await ok.text();
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
