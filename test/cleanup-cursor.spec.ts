import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { cleanupChallenges, CHALLENGE_PREFIX } from '../src/worker/auth/challenges';
import { cleanupOwnerSessions, sessionKey } from '../src/worker/auth/sessions';
import { cleanupExpired } from '../src/worker/storage';
import { resetStorage } from './utils/test-setup';

const bucket = () => env.R2_STORAGE;
const NOW = 2_000_000_000;

async function putChallenge(name: string, expiresAt: number) {
	await bucket().put(
		`${CHALLENGE_PREFIX}${name}`,
		JSON.stringify({ version: 1, purpose: 'login', sessionHash: null, expiresAt, used: false, payload: null }),
	);
}

async function putSession(name: string, absoluteExpiresAt: number) {
	await bucket().put(
		sessionKey(name),
		JSON.stringify({
			version: 1,
			createdAt: NOW,
			lastSeenAt: NOW,
			absoluteExpiresAt,
			ownerAuthVersion: 1,
			reauthenticatedAt: null,
			reauthMethod: null,
		}),
	);
}

const count = async (prefix: string) => (await bucket().list({ prefix })).objects.length;

describe('FIX-12 cleanup scans in batches and remembers where it stopped', () => {
	beforeEach(resetStorage);

	it('reaches expired challenges that sit behind a full page of live ones', async () => {
		// Names sort live first; a scan that always restarts at the front would never see the expired ones
		for (let i = 0; i < 6; i++) await putChallenge(`a-live-${i}`, NOW + 1000);
		for (let i = 0; i < 4; i++) await putChallenge(`z-old-${i}`, NOW - 1);

		const state = { more: false };
		let removed = 0;
		for (let run = 0; run < 4 && removed < 4; run++) removed += await cleanupChallenges(bucket(), NOW, 3, state);

		expect(removed).toBe(4);
		expect(await count(CHALLENGE_PREFIX)).toBe(6);
	});

	it('reports more work while the pass is unfinished, and nothing once it has wrapped', async () => {
		for (let i = 0; i < 7; i++) await putChallenge(`c-${i}`, NOW + 1000);
		const state = { more: false };

		await cleanupChallenges(bucket(), NOW, 3, state);
		expect(state.more).toBe(true);
		await cleanupChallenges(bucket(), NOW, 3, state);
		expect(state.more).toBe(true);
		await cleanupChallenges(bucket(), NOW, 3, state);
		expect(state.more).toBe(false);
	});

	it('does the same for owner sign-in sessions', async () => {
		for (let i = 0; i < 6; i++) await putSession(`a-live-${i}`, NOW + 1000);
		for (let i = 0; i < 4; i++) await putSession(`z-old-${i}`, NOW - 1);

		const state = { more: false };
		let removed = 0;
		for (let run = 0; run < 4 && removed < 4; run++) removed += await cleanupOwnerSessions(bucket(), NOW, 3, state);

		expect(removed).toBe(4);
		expect(await count('auth/sessions/')).toBe(6);
	});

	it('shows up in the cleanup result so a backlog can be noticed', async () => {
		for (let i = 0; i < 600; i++) await putChallenge(`b-${String(i).padStart(4, '0')}`, NOW + 1000);

		const first = await cleanupExpired(bucket(), NOW);
		expect(first.backlog.challenges).toBe(true);
		const second = await cleanupExpired(bucket(), NOW);
		expect(second.backlog.challenges).toBe(false);
	});
});
