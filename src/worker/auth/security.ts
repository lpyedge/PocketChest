/**
 * Owner security settings: which sign-in methods are on, passkey removal, password change and
 * authenticator enrolment. Every change is one owner CAS that bumps authVersion, and the caller's own
 * session is then replaced, so every other session stops working.
 *
 * One deliberate exception: adding a passkey (auth/passkeys.ts) does not bump authVersion. It needs a fresh
 * re-entry, does not switch the method on, and ending the owner's sessions for it would sign them out of the
 * page they just used. It still checks, in the same CAS as the write, that the session belongs to the current
 * version, so a session from before a reset cannot add one.
 */
import { ApiError } from '../errors';
import { toBase64Url } from './encoding';
import { beginAttempts, storeChallenge } from './challenges';
import { hashPassword, verifyPassword } from './password';
import { isConfigured, loadOwner, mutateOwner, Method, OwnerConflictError, OwnerInvariantError, OwnerRecord } from './owner';
import { openSeed, sealSeed, generateSeed, base32Encode, matchTotpStep } from './totp';
import { assertRecentReauth, issueOwnerSession, LoadedSession, markReauthenticated, revokeOwnerSession, sha256Hex } from './sessions';

export const MIN_PASSWORD_LENGTH = 16;
export const MAX_PASSWORD_LENGTH = 1024;
const ENROLL_SECONDS = 5 * 60;
// Wrong codes allowed on one authenticator QR before it has to be made again
const MAX_ENROLL_FAILURES = 5;
const ISSUER = 'PocketChest';

export interface SecuritySummary {
	methods: {
		password: { configured: boolean; enabled: boolean };
		totp: { configured: boolean; enabled: boolean };
		passkey: {
			configured: boolean;
			enabled: boolean;
			credentials: { id: string; label: string; createdAt: number; lastUsedAt: number | null }[];
		};
	};
}

export interface Rotated {
	cookie: string;
	csrfToken: string;
	security: SecuritySummary;
}

/** Only what the settings page needs: never a hash, a seed or a public key. */
export function summarize(owner: OwnerRecord): SecuritySummary {
	const { password, totp, passkey } = owner.methods;
	return {
		methods: {
			password: { configured: password.hash !== null, enabled: password.enabled },
			totp: { configured: totp.encryptedSecret !== null, enabled: totp.enabled },
			passkey: {
				configured: passkey.credentials.length > 0,
				enabled: passkey.enabled,
				credentials: passkey.credentials.map((credential) => ({
					id: credential.id,
					label: credential.label,
					createdAt: credential.createdAt,
					lastUsedAt: credential.lastUsedAt,
				})),
			},
		},
	};
}

export async function securityStatus(bucket: R2Bucket): Promise<SecuritySummary> {
	const loaded = await loadOwner(bucket);
	if (!loaded) {
		throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in required');
	}
	return summarize(loaded.owner);
}

function withEnabled(owner: OwnerRecord, method: Method, enabled: boolean): OwnerRecord {
	const { methods } = owner;
	switch (method) {
		case 'password':
			return { ...owner, methods: { ...methods, password: { ...methods.password, enabled } } };
		case 'totp':
			return { ...owner, methods: { ...methods, totp: { ...methods.totp, enabled } } };
		case 'passkey':
			return { ...owner, methods: { ...methods, passkey: { ...methods.passkey, enabled } } };
	}
}

/**
 * Ends the current session, and starts a new one for the same caller with the same re-entry time.
 * Called after authVersion changed, so the old session and every other session are already invalid.
 */
async function rotate(
	env: { R2_STORAGE: R2Bucket; JWT_SECRET: string },
	session: LoadedSession,
	written: OwnerRecord,
	now: number,
): Promise<Rotated> {
	if (session.record.reauthMethod === null || session.record.reauthenticatedAt === null) {
		throw new ApiError(401, 'AUTH_INVALID', 'Sign in required');
	}
	// The new session is made for the record this very change wrote, never for whatever is stored now
	const issued = await issueOwnerSession(env.R2_STORAGE, env.JWT_SECRET, written.authVersion, now);
	await markReauthenticated(env.R2_STORAGE, issued.sid, now, session.record.reauthMethod, session.record.reauthenticatedAt);
	await revokeOwnerSession(env.R2_STORAGE, session.sid);
	return { cookie: issued.cookie, csrfToken: issued.csrfToken, security: summarize(written) };
}

/**
 * Applies a change on behalf of `session`. The check that the session still belongs to the current owner
 * version runs inside the same compare-and-swap as the change, so a request that started before another
 * change (password reset, CLI reset) cannot act after it.
 */
function mutateAsSession(bucket: R2Bucket, session: LoadedSession, mutate: (owner: OwnerRecord) => OwnerRecord): Promise<OwnerRecord> {
	return mutateOwner(bucket, (owner) => {
		if (owner.authVersion !== session.record.ownerAuthVersion) {
			throw new ApiError(401, 'AUTH_INVALID', 'Sign in required');
		}
		return mutate(owner);
	});
}

function assertCurrent(owner: OwnerRecord, session: LoadedSession): void {
	if (owner.authVersion !== session.record.ownerAuthVersion) {
		throw new ApiError(401, 'AUTH_INVALID', 'Sign in required');
	}
}

function conflict(error: unknown): unknown {
	if (error instanceof OwnerConflictError) {
		return new ApiError(409, 'CONFLICT', 'Security settings changed elsewhere; reload and try again');
	}
	if (error instanceof OwnerInvariantError) {
		return new ApiError(409, 'LAST_AUTH_METHOD', 'At least one sign-in method must stay on');
	}
	return error;
}

/** Switches one method on or off. Switching on needs a fresh re-entry with that same method. */
export async function setMethodEnabled(
	env: { R2_STORAGE: R2Bucket; JWT_SECRET: string },
	session: LoadedSession,
	method: Method,
	enabled: boolean,
	now: number,
): Promise<Rotated> {
	assertRecentReauth(session, now);
	if (enabled) {
		const loaded = await loadOwner(env.R2_STORAGE);
		if (!loaded) {
			throw new ApiError(401, 'AUTH_INVALID', 'Sign in required');
		}
		assertCurrent(loaded.owner, session);
		if (!isConfigured(loaded.owner, method)) {
			throw new ApiError(409, 'AUTH_METHOD_NOT_CONFIGURED', 'This method has not been set up yet');
		}
		// Proof that the owner still holds this method: the re-entry was made with it
		assertRecentReauth(session, now, method);
	}
	let written: OwnerRecord;
	try {
		written = await mutateAsSession(env.R2_STORAGE, session, (owner) => {
			if (enabled && !isConfigured(owner, method)) {
				throw new ApiError(409, 'AUTH_METHOD_NOT_CONFIGURED', 'This method has not been set up yet');
			}
			return { ...withEnabled(owner, method, enabled), authVersion: owner.authVersion + 1 };
		});
	} catch (error) {
		throw conflict(error);
	}
	return rotate(env, session, written, now);
}

/** Removes one passkey. Removing the last one also switches the passkey method off. */
export async function removePasskey(
	env: { R2_STORAGE: R2Bucket; JWT_SECRET: string },
	session: LoadedSession,
	credentialId: string,
	now: number,
): Promise<Rotated> {
	assertRecentReauth(session, now);
	let written: OwnerRecord;
	try {
		written = await mutateAsSession(env.R2_STORAGE, session, (owner) => {
			const remaining = owner.methods.passkey.credentials.filter((credential) => credential.id !== credentialId);
			if (remaining.length === owner.methods.passkey.credentials.length) {
				throw new ApiError(404, 'PASSKEY_NOT_FOUND', 'No such passkey');
			}
			return {
				...owner,
				authVersion: owner.authVersion + 1,
				methods: {
					...owner.methods,
					passkey: { enabled: remaining.length > 0 && owner.methods.passkey.enabled, credentials: remaining },
				},
			};
		});
	} catch (error) {
		throw conflict(error);
	}
	return rotate(env, session, written, now);
}

/** Replaces the password hash with one made from a new salt. The method's enabled flag is left as it is. */
export async function changePassword(
	env: { R2_STORAGE: R2Bucket; JWT_SECRET: string },
	session: LoadedSession,
	newPassword: unknown,
	confirmPassword: unknown,
	now: number,
): Promise<Rotated> {
	assertRecentReauth(session, now);
	if (typeof newPassword !== 'string' || typeof confirmPassword !== 'string') {
		throw new ApiError(400, 'INVALID_REQUEST', 'A new password and its confirmation are required');
	}
	if (newPassword !== confirmPassword) {
		throw new ApiError(400, 'PASSWORD_MISMATCH', 'The two passwords do not match');
	}
	if (newPassword.length < MIN_PASSWORD_LENGTH) {
		throw new ApiError(400, 'PASSWORD_TOO_SHORT', `Use at least ${MIN_PASSWORD_LENGTH} characters`);
	}
	if (newPassword.length > MAX_PASSWORD_LENGTH) {
		throw new ApiError(400, 'PASSWORD_TOO_LONG', 'That password is too long');
	}
	if (new Set(newPassword).size < 4) {
		throw new ApiError(400, 'PASSWORD_TOO_WEAK', 'Use a less repetitive password');
	}

	const loaded = await loadOwner(env.R2_STORAGE);
	if (!loaded) {
		throw new ApiError(401, 'AUTH_INVALID', 'Sign in required');
	}
	assertCurrent(loaded.owner, session);
	const current = loaded.owner.methods.password.hash;
	if (current && (await verifyPassword(newPassword, current))) {
		throw new ApiError(400, 'PASSWORD_UNCHANGED', 'Choose a password different from the current one');
	}
	const hash = await hashPassword(newPassword);
	let written: OwnerRecord;
	try {
		written = await mutateAsSession(env.R2_STORAGE, session, (owner) => ({
			...owner,
			authVersion: owner.authVersion + 1,
			methods: { ...owner.methods, password: { ...owner.methods.password, hash } },
		}));
	} catch (error) {
		throw conflict(error);
	}
	return rotate(env, session, written, now);
}

/** Step one of TOTP enrolment: a new seed is made and kept sealed under a single-use challenge. */
export async function prepareTotp(env: { R2_STORAGE: R2Bucket; AUTH_ENCRYPTION_KEY?: string }, session: LoadedSession, now: number) {
	assertRecentReauth(session, now);
	const seed = generateSeed();
	const sealed = await sealSeed(seed, env.AUTH_ENCRYPTION_KEY);
	const challenge = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
	await storeChallenge(env.R2_STORAGE, challenge, 'totp-enroll', await sha256Hex(session.sid), now, {
		ttlSeconds: ENROLL_SECONDS,
		payload: sealed,
	});
	const otpauthUri = `otpauth://totp/${ISSUER}:owner?secret=${base32Encode(seed)}&issuer=${ISSUER}&algorithm=SHA1&digits=6&period=30`;
	return { challenge, otpauthUri, expiresIn: ENROLL_SECONDS };
}

/**
 * Step two: the code from the new seed replaces the stored seed. A wrong code changes nothing, and the
 * old seed stays in use. Success resets the replay record and rotates the session.
 */
export async function confirmTotp(
	env: { R2_STORAGE: R2Bucket; JWT_SECRET: string; AUTH_ENCRYPTION_KEY?: string },
	session: LoadedSession,
	challenge: string,
	code: string,
	now: number,
): Promise<Rotated> {
	assertRecentReauth(session, now);
	// A superseded session must not use up the enrolment challenge either
	const loaded = await loadOwner(env.R2_STORAGE);
	if (!loaded) {
		throw new ApiError(401, 'AUTH_INVALID', 'Sign in required');
	}
	assertCurrent(loaded.owner, session);
	// Wrong codes are counted on the challenge instead of using it up, so a typo does not make the QR on screen useless
	const attempts = await beginAttempts(env.R2_STORAGE, challenge, 'totp-enroll', await sha256Hex(session.sid), now, MAX_ENROLL_FAILURES);
	const payload = attempts.payload;
	if (payload === null) {
		throw new ApiError(400, 'CHALLENGE_INVALID', 'The sign-in step expired or was already used; start again');
	}
	const seed = await openSeed(payload, env.AUTH_ENCRYPTION_KEY);
	const step = await matchTotpStep(seed, code, now);
	if (step === null) {
		const { ended } = await attempts.fail();
		if (ended) {
			throw new ApiError(400, 'CHALLENGE_INVALID', 'Too many wrong codes; start again');
		}
		throw new ApiError(400, 'TOTP_CODE_INVALID', 'That code does not match; the previous authenticator is still in use');
	}
	await attempts.succeed();
	let written: OwnerRecord;
	try {
		written = await mutateAsSession(env.R2_STORAGE, session, (owner) => ({
			...owner,
			authVersion: owner.authVersion + 1,
			methods: {
				...owner.methods,
				totp: { ...owner.methods.totp, encryptedSecret: payload, lastAcceptedStep: step },
			},
		}));
	} catch (error) {
		throw conflict(error);
	}
	return rotate(env, session, written, now);
}
