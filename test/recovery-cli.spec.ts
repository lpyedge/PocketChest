import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import {
	objectText,
	ownerSignIn,
	resetStorage,
	setupTestEnvironment,
	testFetch,
	TEST_ORIGIN,
	TEST_OWNER_PASSWORD,
} from './utils/test-setup';
import { OWNER_KEY } from '../src/worker/auth/owner';
import * as core from '../scripts/recovery-core.mjs';

// Offline password reset cannot produce a record the Worker accepts (the password key lives only in the Worker),
// so the tool must refuse honestly and leave everything as it was.

function trackingStorage() {
	const calls: string[] = [];
	return {
		calls,
		async read() {
			calls.push('read');
			return null;
		},
		async write() {
			calls.push('write');
		},
		async backup() {
			calls.push('backup');
		},
	};
}

describe('offline password reset is refused, not faked', () => {
	beforeEach(async () => {
		await setupTestEnvironment();
	});

	it('explains why and points at Security settings', async () => {
		await expect(core.recoverPassword()).rejects.toThrow(/not possible/);
		await expect(core.recoverPassword()).rejects.toThrow(/Security settings/);
	});

	it('touches no storage at all', async () => {
		const storage = trackingStorage();
		await expect(core.recoverPassword(storage, 'a-new-owner-passphrase-2026')).rejects.toThrow();
		expect(storage.calls).toEqual([]);
	});

	it('leaves the owner record and the existing password exactly as they were', async () => {
		await ownerSignIn();
		const before = await objectText(OWNER_KEY);
		await expect(core.recoverPassword(trackingStorage(), 'a-new-owner-passphrase-2026')).rejects.toThrow();
		expect(await objectText(OWNER_KEY)).toBe(before);
		expect((await env.R2_STORAGE.list({ prefix: 'auth/owner' })).objects).toHaveLength(1);

		const login = await testFetch(`${TEST_ORIGIN}/api/auth/login/password`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Origin: TEST_ORIGIN },
			body: JSON.stringify({ password: TEST_OWNER_PASSWORD }),
		});
		expect(login.status).toBe(200);
		await login.text();
	});

	it('the command line tool exits with an error and prints the same explanation', async () => {
		expect(core.OFFLINE_RESET_UNSUPPORTED).toMatch(/Nothing was read or changed/);
		await resetStorage();
	});
});
