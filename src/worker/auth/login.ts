/**
 * Sign-in methods the owner can use. Each method is checked on its own; a method that is not enabled
 * (or not configured) never grants access, whatever the others say.
 */
import { ApiError } from '../errors';
import { BOOTSTRAP_MARKER_KEY } from './bootstrap';
import { isUsable, loadOwner, Method, OwnerRecord } from './owner';
import { verifyPassword } from './password';
import { issueOwnerSession, LoadedSession, markReauthenticated } from './sessions';

export interface AuthEnv {
	R2_STORAGE: R2Bucket;
	JWT_SECRET: string;
	BOOTSTRAP_ENABLED?: string;
	ADMIN_BOOTSTRAP_PASSWORD?: string;
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

// Returns the owner the password was checked against, so callers use that same state
async function checkPassword(env: AuthEnv, password: string): Promise<OwnerRecord> {
	const loaded = await loadOwner(env.R2_STORAGE);
	if (!loaded) {
		throw new ApiError(401, 'AUTH_INVALID_CREDENTIALS', 'Invalid credentials');
	}
	const { owner } = loaded;
	if (!isUsable(owner, 'password') || owner.methods.password.hash === null) {
		throw new ApiError(403, 'AUTH_METHOD_DISABLED', 'Password sign-in is not enabled');
	}
	if (!(await verifyPassword(password, owner.methods.password.hash))) {
		throw new ApiError(401, 'AUTH_INVALID_CREDENTIALS', 'Invalid credentials');
	}
	return owner;
}

// Signs the owner in with the password, starting a new session (new id, so no fixation)
export async function loginWithPassword(
	env: AuthEnv,
	password: string,
	now: number,
): Promise<{ sid: string; csrfToken: string; cookie: string }> {
	const owner = await checkPassword(env, password);
	return issueOwnerSession(env.R2_STORAGE, env.JWT_SECRET, owner.authVersion, now);
}

// Re-confirms the owner's password inside an existing session, opening the reauth window
export async function reauthWithPassword(env: AuthEnv, session: LoadedSession, password: string, now: number): Promise<void> {
	await checkPassword(env, password);
	await markReauthenticated(env.R2_STORAGE, session.sid, now);
}
