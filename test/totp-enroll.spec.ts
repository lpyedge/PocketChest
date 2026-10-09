import { env } from 'cloudflare:test';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { ownerSignIn, ownerRecord, resetStorage, setupTestEnvironment } from './utils/test-setup';
import { adoptRotated, call, configureTotp, reauthPassword, setEnabled, SignedIn } from './utils/security-helpers';
import { loginWithTotp } from '../src/worker/auth/login';
import { openSeed, totpCodeAt } from '../src/worker/auth/totp';
import { markReauthenticated, sha256Hex } from '../src/worker/auth/sessions';
import { prepareTotp, confirmTotp } from '../src/worker/auth/security';
import type { LoadedSession } from '../src/worker/auth/sessions';

const OLD_SEED = new Uint8Array(20).map((_, index) => 11 + index);
const NOW = 1_800_000_000;
const env2 = env as unknown as { R2_STORAGE: R2Bucket; JWT_SECRET: string; AUTH_ENCRYPTION_KEY?: string };

function sessionFor(owner: SignedIn, sid: string, reauthenticatedAt: number): LoadedSession {
	return {
		key: '',
		sid,
		record: {
			version: 1,
			createdAt: reauthenticatedAt,
			lastSeenAt: reauthenticatedAt,
			absoluteExpiresAt: reauthenticatedAt + 100_000,
			ownerAuthVersion: 1,
			reauthenticatedAt,
			reauthMethod: 'password',
		},
	};
}

async function sidOf(owner: SignedIn): Promise<string> {
	return owner.cookie.split('=')[1];
}

describe('authenticator enrolment', () => {
	beforeAll(async () => {
		await resetStorage();
	});

	beforeEach(async () => {
		await setupTestEnvironment();
	});

	it('needs a recent re-entry to prepare', async () => {
		const owner = await ownerSignIn();
		const response = await call(owner, 'POST', '/api/admin/security/totp/prepare', {});
		expect(response.status).toBe(403);
		await response.text();
	});

	it('prepares a new seed as an otpauth URI, and leaves the owner record alone', async () => {
		const owner = await ownerSignIn();
		await reauthPassword(owner);
		const before = JSON.stringify(await ownerRecord());

		const response = await call(owner, 'POST', '/api/admin/security/totp/prepare', {});
		expect(response.status).toBe(200);
		const data = (await response.json()) as any;
		expect(data.otpauthUri).toMatch(/^otpauth:\/\/totp\/PocketChest:owner\?secret=[A-Z2-7]+&issuer=PocketChest/);
		expect(data.expiresIn).toBe(300);
		expect(JSON.stringify(await ownerRecord())).toBe(before);
	});

	it('replaces the seed when the code from the new seed is confirmed, and the old seed stops working', async () => {
		const owner = await ownerSignIn();
		await configureTotp(OLD_SEED, true);
		await reauthPassword(owner);

		const prepared = (await (await call(owner, 'POST', '/api/admin/security/totp/prepare', {})).json()) as any;
		const newSeed = base32ToBytes(prepared.otpauthUri.match(/secret=([A-Z2-7]+)/)![1]);
		const code = await totpCodeAt(newSeed, Math.floor(Date.now() / 1000));

		const confirmed = await call(owner, 'POST', '/api/admin/security/totp/confirm', { challenge: prepared.challenge, code });
		expect(confirmed.status).toBe(200);
		const { session: replaced } = await adoptRotated(owner, confirmed);

		const stored = await ownerRecord();
		expect(await openSeed(stored.methods.totp.encryptedSecret!, env2.AUTH_ENCRYPTION_KEY)).toEqual(newSeed);
		expect(stored.methods.totp.lastAcceptedStep).not.toBeNull();

		// The old session is gone, the replacement works, and the old authenticator no longer signs in
		const status = await call(replaced, 'GET', '/api/admin/security');
		expect(status.status).toBe(200);
		await status.text();
		await setEnabled('totp', true);
		await expect(loginWithTotp(env2 as never, await totpCodeAt(OLD_SEED, NOW), NOW)).rejects.toMatchObject({ status: 401 });
	});

	it('keeps the old seed when a wrong code is entered, and changes nothing in the owner record', async () => {
		const owner = await ownerSignIn();
		await configureTotp(OLD_SEED, true);
		await reauthPassword(owner);
		const prepared = (await (await call(owner, 'POST', '/api/admin/security/totp/prepare', {})).json()) as any;
		const before = JSON.stringify(await ownerRecord());

		const wrong = await call(owner, 'POST', '/api/admin/security/totp/confirm', { challenge: prepared.challenge, code: '000000' });
		expect(wrong.status).toBe(400);
		expect(((await wrong.json()) as any).code).toBe('TOTP_CODE_INVALID');
		expect(JSON.stringify(await ownerRecord())).toBe(before);
	});

	it('C05: lets the right code succeed after a wrong one on the same QR', async () => {
		const owner = await ownerSignIn();
		await configureTotp(OLD_SEED, true);
		await reauthPassword(owner);
		const prepared = (await (await call(owner, 'POST', '/api/admin/security/totp/prepare', {})).json()) as any;
		const newSeed = base32ToBytes(prepared.otpauthUri.match(/secret=([A-Z2-7]+)/)![1]);
		const before = JSON.stringify(await ownerRecord());

		const wrong = await call(owner, 'POST', '/api/admin/security/totp/confirm', { challenge: prepared.challenge, code: '000000' });
		expect(((await wrong.json()) as any).code).toBe('TOTP_CODE_INVALID');
		// The old authenticator is untouched until a code from the new seed is accepted
		expect(JSON.stringify(await ownerRecord())).toBe(before);

		const code = await totpCodeAt(newSeed, Math.floor(Date.now() / 1000));
		const right = await call(owner, 'POST', '/api/admin/security/totp/confirm', { challenge: prepared.challenge, code });
		expect(right.status).toBe(200);
		await right.text();
		expect(await openSeed((await ownerRecord()).methods.totp.encryptedSecret!, env2.AUTH_ENCRYPTION_KEY)).toEqual(newSeed);
	});

	it('C06: ends the enrolment after five wrong codes, so the QR cannot be guessed at without limit', async () => {
		const owner = await ownerSignIn();
		await configureTotp(OLD_SEED, true);
		await reauthPassword(owner);
		const prepared = (await (await call(owner, 'POST', '/api/admin/security/totp/prepare', {})).json()) as any;
		const newSeed = base32ToBytes(prepared.otpauthUri.match(/secret=([A-Z2-7]+)/)![1]);
		const before = JSON.stringify(await ownerRecord());

		const codes: string[] = [];
		for (let attempt = 0; attempt < 5; attempt++) {
			const wrong = await call(owner, 'POST', '/api/admin/security/totp/confirm', { challenge: prepared.challenge, code: '000000' });
			codes.push(((await wrong.json()) as any).code);
		}
		expect(codes).toEqual(['TOTP_CODE_INVALID', 'TOTP_CODE_INVALID', 'TOTP_CODE_INVALID', 'TOTP_CODE_INVALID', 'CHALLENGE_INVALID']);

		// Even the correct code is now refused, and the owner record never changed
		const code = await totpCodeAt(newSeed, Math.floor(Date.now() / 1000));
		const late = await call(owner, 'POST', '/api/admin/security/totp/confirm', { challenge: prepared.challenge, code });
		expect(((await late.json()) as any).code).toBe('CHALLENGE_INVALID');
		expect(JSON.stringify(await ownerRecord())).toBe(before);
	});

	it('C06: ten parallel wrong codes still count against the same limit', async () => {
		const owner = await ownerSignIn();
		await reauthPassword(owner);
		const prepared = (await (await call(owner, 'POST', '/api/admin/security/totp/prepare', {})).json()) as any;
		const newSeed = base32ToBytes(prepared.otpauthUri.match(/secret=([A-Z2-7]+)/)![1]);

		const responses = await Promise.all(
			Array.from({ length: 10 }, () =>
				call(owner, 'POST', '/api/admin/security/totp/confirm', { challenge: prepared.challenge, code: '000000' }),
			),
		);
		for (const response of responses) await response.text();

		const code = await totpCodeAt(newSeed, Math.floor(Date.now() / 1000));
		const late = await call(owner, 'POST', '/api/admin/security/totp/confirm', { challenge: prepared.challenge, code });
		expect(((await late.json()) as any).code).toBe('CHALLENGE_INVALID');
	});

	it('does not accept the same challenge twice', async () => {
		const owner = await ownerSignIn();
		await reauthPassword(owner);
		const prepared = (await (await call(owner, 'POST', '/api/admin/security/totp/prepare', {})).json()) as any;
		const newSeed = base32ToBytes(prepared.otpauthUri.match(/secret=([A-Z2-7]+)/)![1]);
		const code = await totpCodeAt(newSeed, Math.floor(Date.now() / 1000));
		const first = await call(owner, 'POST', '/api/admin/security/totp/confirm', { challenge: prepared.challenge, code });
		expect(first.status).toBe(200);
		// The first success rotates the session, so the replay is made with the replacement
		const { session: replaced } = await adoptRotated(owner, first);

		const replay = await call(replaced, 'POST', '/api/admin/security/totp/confirm', { challenge: prepared.challenge, code });
		expect(replay.status).toBe(400);
		expect(((await replay.json()) as any).code).toBe('CHALLENGE_INVALID');
	});

	it('refuses confirmation after the five-minute window, and a challenge from another session', async () => {
		const owner = await ownerSignIn();
		const sid = await sidOf(owner);
		await reauthPassword(owner);
		const prepared = await prepareTotp(env2, sessionFor(owner, sid, NOW), NOW);
		const seed = await readSeed(prepared.challenge);

		// Re-entry is refreshed at NOW + 200, so the window is open at NOW + 301, but the challenge has run out
		await markReauthenticated(env2.R2_STORAGE, sid, NOW + 200, 'password');
		await expect(
			confirmTotp(env2, sessionFor(owner, sid, NOW + 200), prepared.challenge, await totpCodeAt(seed, NOW + 301), NOW + 301),
		).rejects.toMatchObject({ status: 400 });

		// A challenge issued to one session cannot be used from another
		const fresh = await prepareTotp(env2, sessionFor(owner, sid, NOW), NOW);
		const other = await ownerSignIn();
		await expect(
			confirmTotp(
				env2,
				sessionFor(other, await sidOf(other), NOW),
				fresh.challenge,
				await totpCodeAt(await readSeed(fresh.challenge), NOW),
				NOW,
			),
		).rejects.toMatchObject({ status: 400 });
	});

	it('keeps the seed sealed in storage', async () => {
		const owner = await ownerSignIn();
		await reauthPassword(owner);
		const prepared = (await (await call(owner, 'POST', '/api/admin/security/totp/prepare', {})).json()) as any;
		const seedText = prepared.otpauthUri.match(/secret=([A-Z2-7]+)/)![1];
		const listing = JSON.stringify(await env2.R2_STORAGE.list());
		const contents = await collectText();
		expect(contents).not.toContain(seedText);
		expect(listing).not.toContain(seedText);
	});
});

// Reads the seed a pending enrolment holds, for the tests that need to generate its codes
async function readSeed(challenge: string): Promise<Uint8Array> {
	const object = await env2.R2_STORAGE.get(`auth/challenges/${await sha256Hex(challenge)}`);
	const record = JSON.parse(await object!.text());
	return openSeed(record.payload, env2.AUTH_ENCRYPTION_KEY);
}

async function collectText(): Promise<string> {
	const listed = await env2.R2_STORAGE.list();
	const parts: string[] = [];
	for (const object of listed.objects) {
		const stored = await env2.R2_STORAGE.get(object.key);
		parts.push(await stored!.text());
	}
	return parts.join('\n');
}

function base32ToBytes(text: string): Uint8Array {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
	let bits = 0;
	let value = 0;
	const out: number[] = [];
	for (const char of text) {
		value = (value << 5) | alphabet.indexOf(char);
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}
	return Uint8Array.from(out);
}
