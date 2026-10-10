import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import { createOwnerOnce, mutateOwner } from '../src/worker/auth/owner';
import { changePassword, confirmTotp, removePasskey, setMethodEnabled } from '../src/worker/auth/security';
import { LoadedSession } from '../src/worker/auth/sessions';
import { ownerRecord, resetStorage, setupTestEnvironment, TEST_OWNER_PASSWORD, TEST_JWT_SECRET } from './utils/test-setup';

const NOW = Math.floor(Date.now() / 1000);

// The state of a request that passed requireOwner() while the owner was still at `ownerAuthVersion`
function inFlightSession(ownerAuthVersion: number): LoadedSession {
	return {
		key: 'owner-sessions/test',
		sid: 'in-flight-sid',
		record: {
			version: 1,
			createdAt: NOW,
			lastSeenAt: NOW,
			absoluteExpiresAt: NOW + 3600,
			ownerAuthVersion,
			reauthenticatedAt: NOW,
			reauthMethod: 'password',
		} as LoadedSession['record'],
	};
}

async function sessionKeys(): Promise<string[]> {
	return (await env.R2_STORAGE.list({ prefix: 'auth/sessions/' })).objects.map((o) => o.key);
}

describe('FIX-04 an in-flight request from a superseded session', () => {
	beforeEach(async () => {
		await resetStorage();
		await setupTestEnvironment();
		await createOwnerOnce(env.R2_STORAGE, TEST_OWNER_PASSWORD, TEST_JWT_SECRET);
	});

	async function supersede(): Promise<{ session: LoadedSession; before: string }> {
		const session = inFlightSession((await ownerRecord()).authVersion);
		// Another request (password change, CLI reset) moves the owner on while this one is running
		await mutateOwner(env.R2_STORAGE, (owner) => ({ ...owner, authVersion: owner.authVersion + 1 }));
		return { session, before: JSON.stringify(await ownerRecord()) };
	}

	async function expectRefused(promise: Promise<unknown>, before: string) {
		await expect(promise).rejects.toMatchObject({ status: 401, code: 'AUTH_INVALID' });
		expect(JSON.stringify(await ownerRecord())).toBe(before);
		expect(await sessionKeys()).toEqual([]);
	}

	it('cannot switch a method', async () => {
		const { session, before } = await supersede();
		await expectRefused(setMethodEnabled(env, session, 'password', false, NOW), before);
	});

	it('cannot remove a passkey', async () => {
		const { session, before } = await supersede();
		await expectRefused(removePasskey(env, session, 'whatever', NOW), before);
	});

	it('cannot change the password', async () => {
		const { session, before } = await supersede();
		await expectRefused(changePassword(env, session, 'a-brand-new-password-1', 'a-brand-new-password-1', NOW), before);
	});

	it('cannot confirm an authenticator', async () => {
		const { session, before } = await supersede();
		await expectRefused(confirmTotp(env, session, 'nochallenge', '000000', NOW), before);
	});

	it('still works when the session is current, and returns a session for the version it wrote', async () => {
		const session = inFlightSession((await ownerRecord()).authVersion);
		const rotated = await setMethodEnabled(env, session, 'password', true, NOW);
		const owner = await ownerRecord();
		expect(rotated.cookie).toBeTruthy();
		expect(await sessionKeys()).toHaveLength(1);
		const stored = JSON.parse(await (await env.R2_STORAGE.get((await sessionKeys())[0]))!.text());
		expect(stored.ownerAuthVersion).toBe(owner.authVersion);
	});
});
