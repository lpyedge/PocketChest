/**
 * Sign-in methods the owner can use. Each method is checked on its own; a method that is not enabled
 * (or not configured) never grants access, whatever the others say.
 */
import { ApiError } from '../errors';
import { BOOTSTRAP_MARKER_KEY } from './bootstrap';
import { isConfigured, isUsable, loadOwner, mutateOwner, Method, OwnerConflictError, OwnerRecord } from './owner';
import { verifyPassword } from './password';
import { matchTotpStep, openSeed } from './totp';
import { assertNotLocked, clearFailures, recordFailure, ThrottledMethod } from './throttle';
import { issueOwnerSession, LoadedSession, markReauthenticated } from './sessions';

export interface AuthEnv {
	R2_STORAGE: R2Bucket;
	JWT_SECRET: string;
	BOOTSTRAP_ENABLED?: string;
	ADMIN_BOOTSTRAP_PASSWORD?: string;
	AUTH_ENCRYPTION_KEY?: string;
}

export interface MethodsStatus {
	setupRequired: boolean;
	methods: Record<Method, { enabled: boolean }>;
}

// Only reveals whether a method is usable, never seeds, hashes or credential data
export async function authMethods(env: AuthEnv): Promise<MethodsStatus> {
	const loaded = await loadOwner(env.R2_STORAGE);
	const methods: Record<Method, { enabled: boolean }> = {
		password: { enabled: loaded ? isUsable(loaded.owner, 'password') : false },
		totp: { enabled: loaded ? isUsable(loaded.owner, 'totp') : false },
		passkey: { enabled: loaded ? isUsable(loaded.owner, 'passkey') : false },
	};

	// Setup is offered only on an empty bucket, with bootstrap switched on, and never after a claim
	const setupRequired =
		loaded === null &&
		env.BOOTSTRAP_ENABLED === 'true' &&
		Boolean(env.ADMIN_BOOTSTRAP_PASSWORD) &&
		(await env.R2_STORAGE.head(BOOTSTRAP_MARKER_KEY)) === null;

	return { setupRequired, methods };
}

// Mode 'login' needs the method enabled; 'reauth' only needs the owner to hold it, since the owner is already signed in
type Mode = 'login' | 'reauth';
const usable = (owner: OwnerRecord, method: Method, mode: Mode) =>
	mode === 'login' ? isUsable(owner, method) : isConfigured(owner, method);

// Returns the owner the password was checked against, so callers use that same state
async function checkPassword(env: AuthEnv, password: string, mode: Mode): Promise<OwnerRecord> {
	const loaded = await loadOwner(env.R2_STORAGE);
	if (!loaded) {
		throw new ApiError(401, 'AUTH_INVALID_CREDENTIALS', 'Invalid credentials');
	}
	const { owner } = loaded;
	if (!usable(owner, 'password', mode) || owner.methods.password.hash === null) {
		throw new ApiError(403, 'AUTH_METHOD_DISABLED', 'Password sign-in is not enabled');
	}
	if (!(await verifyPassword(password, owner.methods.password.hash))) {
		throw new ApiError(401, 'AUTH_INVALID_CREDENTIALS', 'Invalid credentials');
	}
	return owner;
}

/**
 * Runs one credential attempt under the owner-level lockout: refused while the method is locked, a
 * wrong credential counts as a failure, and a success clears this method's counter only.
 */
async function guarded<T>(env: AuthEnv, method: ThrottledMethod, now: number, attempt: () => Promise<T>): Promise<T> {
	await assertNotLocked(env.R2_STORAGE, method, now);
	try {
		const result = await attempt();
		await clearFailures(env.R2_STORAGE, method, now);
		return result;
	} catch (error) {
		if (error instanceof ApiError && error.code === 'AUTH_INVALID_CREDENTIALS') {
			await recordFailure(env.R2_STORAGE, method, now);
		}
		throw error;
	}
}

// Signs the owner in with the password, starting a new session (new id, so no fixation)
export async function loginWithPassword(
	env: AuthEnv,
	password: string,
	now: number,
): Promise<{ sid: string; csrfToken: string; cookie: string }> {
	return guarded(env, 'password', now, async () => {
		const owner = await checkPassword(env, password, 'login');
		return issueOwnerSession(env.R2_STORAGE, env.JWT_SECRET, owner.authVersion, now);
	});
}

// Re-confirms the owner's password inside an existing session, opening the reauth window
export async function reauthWithPassword(env: AuthEnv, session: LoadedSession, password: string, now: number): Promise<void> {
	await guarded(env, 'password', now, async () => {
		await checkPassword(env, password, 'reauth');
		await markReauthenticated(env.R2_STORAGE, session.sid, now, 'password');
	});
}

// Raised inside the owner update when the code cannot be accepted any more
class TotpRejectedError extends Error {}

/**
 * Checks a TOTP code and records its time step, so the same step is never accepted twice. The
 * step is recorded with an owner CAS, so two requests carrying the same code cannot both succeed.
 */
async function consumeTotpCode(env: AuthEnv, code: string, now: number, mode: Mode): Promise<OwnerRecord> {
	const loaded = await loadOwner(env.R2_STORAGE);
	if (!loaded) {
		throw new ApiError(401, 'AUTH_INVALID_CREDENTIALS', 'Invalid credentials');
	}
	const sealed = loaded.owner.methods.totp.encryptedSecret;
	if (!usable(loaded.owner, 'totp', mode) || sealed === null) {
		throw new ApiError(403, 'AUTH_METHOD_DISABLED', 'Authenticator sign-in is not enabled');
	}
	const seed = await openSeed(sealed, env.AUTH_ENCRYPTION_KEY);
	const step = await matchTotpStep(seed, code, now);
	if (step === null) {
		throw new ApiError(401, 'AUTH_INVALID_CREDENTIALS', 'Invalid credentials');
	}

	try {
		return await mutateOwner(env.R2_STORAGE, (latest) => {
			const totp = latest.methods.totp;
			// The seed or the method may have changed since it was read; the code is then not accepted
			if (!usable(latest, 'totp', mode) || totp.encryptedSecret?.ct !== sealed.ct) {
				throw new TotpRejectedError();
			}
			if (totp.lastAcceptedStep !== null && step <= totp.lastAcceptedStep) {
				throw new TotpRejectedError();
			}
			return { ...latest, methods: { ...latest.methods, totp: { ...totp, lastAcceptedStep: step } } };
		});
	} catch (error) {
		if (error instanceof TotpRejectedError) {
			throw new ApiError(401, 'AUTH_INVALID_CREDENTIALS', 'Invalid credentials');
		}
		if (error instanceof OwnerConflictError) {
			throw new ApiError(409, 'CONFLICT', 'Sign-in is busy, try again');
		}
		throw error;
	}
}

// Signs the owner in with an authenticator code alone; the password is not needed
export async function loginWithTotp(env: AuthEnv, code: string, now: number): Promise<{ sid: string; csrfToken: string; cookie: string }> {
	return guarded(env, 'totp', now, async () => {
		const owner = await consumeTotpCode(env, code, now, 'login');
		return issueOwnerSession(env.R2_STORAGE, env.JWT_SECRET, owner.authVersion, now);
	});
}

// Re-confirms the owner with an authenticator code inside an existing session
export async function reauthWithTotp(env: AuthEnv, session: LoadedSession, code: string, now: number): Promise<void> {
	await guarded(env, 'totp', now, async () => {
		await consumeTotpCode(env, code, now, 'reauth');
		await markReauthenticated(env.R2_STORAGE, session.sid, now, 'totp');
	});
}
