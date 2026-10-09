import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
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
import { OWNER_KEY } from '../src/worker/auth/owner';
import { verifyPassword, PasswordHash } from '../src/worker/auth/password';
import * as core from '../scripts/recovery-core.mjs';

const bucket = () => env.R2_STORAGE;

// The stored password record; a test that calls this expects a password to be set
async function storedHash() {
	const hash = (await ownerRecord()).methods.password.hash;
	if (!hash) {
		throw new Error('No password hash stored');
	}
	return hash;
}
const NEW_PASSWORD = 'recovered-owner-passphrase-2026';

// Storage for the core: a mock of the management interface, with optional injected changes
function mockStorage(overrides: { changeBeforeSecondRead?: boolean; corrupt?: boolean } = {}) {
	const writes: string[] = [];
	const backups: string[] = [];
	let reads = 0;
	return {
		writes,
		backups,
		async read() {
			reads++;
			const object = await bucket().get(OWNER_KEY);
			if (!object) return null;
			let body = await object.text();
			if (overrides.corrupt) body = '{not json';
			if (overrides.changeBeforeSecondRead && reads === 2) {
				// A concurrent change lands between validation and write
				const record = JSON.parse(body);
				await bucket().put(OWNER_KEY, JSON.stringify({ ...record, authVersion: record.authVersion + 5 }));
				return { body: JSON.stringify({ ...record, authVersion: record.authVersion + 5 }), etag: object.etag };
			}
			return { body, etag: object.etag };
		},
		async write(body: string) {
			writes.push(body);
			await bucket().put(OWNER_KEY, body);
		},
		async backup(body: string) {
			backups.push(body);
		},
	};
}

describe('offline password recovery', () => {
	beforeAll(async () => {
		await resetStorage();
	});

	beforeEach(async () => {
		await setupTestEnvironment();
	});

	it('restores a password the owner has lost, ends old sessions, and turns the password method on', async () => {
		const owner = await ownerSignIn();
		const beforeRecord = await ownerRecord();
		// Simulate a lost password with the password method switched off
		await bucket().put(
			OWNER_KEY,
			JSON.stringify({
				...beforeRecord,
				methods: { ...beforeRecord.methods, password: { ...beforeRecord.methods.password, enabled: false } },
			}),
		);

		const storage = mockStorage();
		const result = await core.recoverPassword(storage, NEW_PASSWORD);

		expect(result.authVersion).toBe(beforeRecord.authVersion + 1);
		const after = await ownerRecord();
		expect(after.methods.password.enabled).toBe(true);
		expect(await verifyPassword(NEW_PASSWORD, after.methods.password.hash as PasswordHash)).toBe(true);
		expect(await verifyPassword(TEST_OWNER_PASSWORD, after.methods.password.hash as PasswordHash)).toBe(false);
		expect(storage.backups).toHaveLength(1);
		expect(storage.writes).toHaveLength(1);

		// The session from before the recovery no longer works
		const status = await testFetch(`${TEST_ORIGIN}/api/auth/session`, { headers: { Cookie: owner.cookie } });
		expect(await status.json()).toMatchObject({ authenticated: false });
	});

	it('keeps the other methods and the stored data as they were', async () => {
		await ownerSignIn();
		const before = JSON.parse(await objectText(OWNER_KEY));
		await env.R2_STORAGE.put('codes/ABC123', 'shared-data-untouched');

		await core.recoverPassword(mockStorage(), NEW_PASSWORD);

		const after = JSON.parse(await objectText(OWNER_KEY));
		expect(after.methods.totp).toEqual(before.methods.totp);
		expect(after.methods.passkey).toEqual(before.methods.passkey);
		expect(after.createdAt).toBe(before.createdAt);
		expect(await objectText('codes/ABC123')).toBe('shared-data-untouched');
	});

	it('stops, without writing, when the record changes between validation and write', async () => {
		await ownerSignIn();
		const before = await objectText(OWNER_KEY);
		const storage = mockStorage({ changeBeforeSecondRead: true });

		await expect(core.recoverPassword(storage, NEW_PASSWORD)).rejects.toThrow(/changed during recovery/);
		expect(storage.writes).toHaveLength(0);
		// The concurrent change is what is stored, and the recovery did not overwrite it
		const stored = JSON.parse(await objectText(OWNER_KEY));
		expect(stored.authVersion).toBe(JSON.parse(before).authVersion + 5);
	});

	it('refuses a record it cannot parse, without writing or overwriting it', async () => {
		await ownerSignIn();
		const before = await objectText(OWNER_KEY);
		const storage = mockStorage({ corrupt: true });

		await expect(core.recoverPassword(storage, NEW_PASSWORD)).rejects.toThrow(/not valid JSON/);
		expect(storage.writes).toHaveLength(0);
		expect(await objectText(OWNER_KEY)).toBe(before);
	});

	it('refuses to run with no owner record, and refuses a short password', async () => {
		await resetStorage();
		await expect(core.recoverPassword(mockStorage(), NEW_PASSWORD)).rejects.toThrow(/No owner record/);
		await ownerSignIn();
		await expect(core.recoverPassword(mockStorage(), 'too-short')).rejects.toThrow(/at least 16/);
	});

	it('gives every recovery a new salt', async () => {
		await ownerSignIn();
		await core.recoverPassword(mockStorage(), NEW_PASSWORD);
		const first = await storedHash();
		await core.recoverPassword(mockStorage(), NEW_PASSWORD);
		const second = await storedHash();
		expect(second.salt).not.toBe(first.salt);
	});
});
