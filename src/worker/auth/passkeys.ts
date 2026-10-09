/**
 * Passkeys (WebAuthn) for the owner. Only the public key and a signature counter are stored; the private
 * key never leaves the authenticator. Options are one-time challenges (auth/challenges.ts), and the
 * relying party is the origin of the request itself, so no other origin can be used.
 */
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { AuthenticationResponseJSON, AuthenticatorTransport, RegistrationResponseJSON } from '@simplewebauthn/server';
import { ApiError } from '../errors';
import { fromBase64Url, toBase64Url } from './encoding';
import { CHALLENGE_SECONDS, consumeChallenge, storeChallenge } from './challenges';
import { isConfigured, isUsable, loadOwner, mutateOwner, OwnerConflictError, OwnerRecord, PasskeyCredential } from './owner';
import { assertRecentReauth, LoadedSession, markReauthenticated, sha256Hex } from './sessions';

export const RP_NAME = 'PocketChest';
const OWNER_USER_NAME = 'owner';
// One owner, so one stable user handle
const OWNER_USER_ID = new Uint8Array(new TextEncoder().encode('pocketchest-owner'));

class CredentialExistsError extends Error {}
class CredentialGoneError extends Error {}

/**
 * The relying party is the origin the request arrived on. When PASSKEY_RP_ID is set, it is the only
 * domain allowed: a request on any other hostname is refused, so passkeys cannot be split across hosts.
 */
export function relyingParty(request: Request, pinnedRpId?: string): { rpID: string; origin: string } {
	const url = new URL(request.url);
	if (pinnedRpId && url.hostname !== pinnedRpId) {
		throw new ApiError(403, 'PASSKEY_DOMAIN_MISMATCH', 'Passkeys are only available on the configured domain');
	}
	return { rpID: pinnedRpId || url.hostname, origin: url.origin };
}

function clampLabel(label: unknown): string {
	const text = typeof label === 'string' ? label.trim().slice(0, 64) : '';
	return text.length > 0 ? text : 'Passkey';
}

function failed(message = 'Passkey could not be verified'): ApiError {
	return new ApiError(400, 'PASSKEY_VERIFY_FAILED', message);
}

function invalidSignIn(): ApiError {
	return new ApiError(401, 'AUTH_INVALID_CREDENTIALS', 'Invalid credentials');
}

function credentialDescriptors(owner: OwnerRecord) {
	return owner.methods.passkey.credentials.map((credential) => ({
		id: credential.id,
		transports: credential.transports as AuthenticatorTransport[],
	}));
}

async function loadOwnerOrThrow(bucket: R2Bucket, failure: () => ApiError): Promise<OwnerRecord> {
	const loaded = await loadOwner(bucket);
	if (!loaded) {
		throw failure();
	}
	return loaded.owner;
}

// --- Registration (signed-in owner, recent password/TOTP/passkey re-entry required) ---

export async function registrationOptions(bucket: R2Bucket, request: Request, session: LoadedSession, now: number, pinnedRpId?: string) {
	assertRecentReauth(session, now);
	const owner = await loadOwnerOrThrow(bucket, () => new ApiError(401, 'AUTH_REQUIRED', 'Sign in required'));
	const { rpID } = relyingParty(request, pinnedRpId);
	const options = await generateRegistrationOptions({
		rpName: RP_NAME,
		rpID,
		userName: OWNER_USER_NAME,
		userID: OWNER_USER_ID,
		attestationType: 'none',
		excludeCredentials: credentialDescriptors(owner),
		authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
		timeout: CHALLENGE_SECONDS * 1000,
	});
	await storeChallenge(bucket, options.challenge, 'register', await sha256Hex(session.sid), now);
	return options;
}

export async function registrationVerify(
	bucket: R2Bucket,
	request: Request,
	session: LoadedSession,
	body: { challenge: string; response: RegistrationResponseJSON; label?: unknown },
	now: number,
	pinnedRpId?: string,
): Promise<{ credentialId: string }> {
	assertRecentReauth(session, now);
	await consumeChallenge(bucket, body.challenge, 'register', await sha256Hex(session.sid), now);

	const { rpID, origin } = relyingParty(request, pinnedRpId);
	const verification = await verifyRegistrationResponse({
		response: body.response,
		expectedChallenge: body.challenge,
		expectedOrigin: origin,
		expectedRPID: rpID,
		requireUserVerification: true,
	}).catch(() => null);
	if (!verification?.verified || !verification.registrationInfo) {
		throw failed();
	}

	const info = verification.registrationInfo.credential;
	const credential: PasskeyCredential = {
		id: info.id,
		publicKey: toBase64Url(info.publicKey),
		counter: info.counter,
		label: clampLabel(body.label),
		createdAt: now,
		lastUsedAt: null,
		transports: info.transports ?? [],
	};
	try {
		// Adding a credential does not switch the method on; that is a separate, explicit toggle
		await mutateOwner(bucket, (owner) => {
			if (owner.methods.passkey.credentials.some((existing) => existing.id === credential.id)) {
				throw new CredentialExistsError();
			}
			return {
				...owner,
				methods: {
					...owner.methods,
					passkey: { ...owner.methods.passkey, credentials: [...owner.methods.passkey.credentials, credential] },
				},
			};
		});
	} catch (error) {
		if (error instanceof CredentialExistsError) {
			throw new ApiError(409, 'PASSKEY_ALREADY_REGISTERED', 'This passkey is already registered');
		}
		if (error instanceof OwnerConflictError) {
			throw new ApiError(409, 'CONFLICT', 'Owner settings changed, try again');
		}
		throw error;
	}
	return { credentialId: credential.id };
}

// --- Sign-in and re-entry with an existing passkey ---

export async function assertionOptions(
	bucket: R2Bucket,
	request: Request,
	purpose: 'login' | 'reauth',
	session: LoadedSession | null,
	now: number,
	pinnedRpId?: string,
) {
	const owner = await loadOwnerOrThrow(bucket, invalidSignIn);
	// Sign-in needs the passkey enabled; re-entry only needs the owner to hold one
	if (purpose === 'login' ? !isUsable(owner, 'passkey') : !isConfigured(owner, 'passkey')) {
		throw new ApiError(403, 'AUTH_METHOD_DISABLED', 'Passkey sign-in is not enabled');
	}
	const { rpID } = relyingParty(request, pinnedRpId);
	const options = await generateAuthenticationOptions({
		rpID,
		allowCredentials: credentialDescriptors(owner),
		userVerification: 'required',
		timeout: CHALLENGE_SECONDS * 1000,
	});
	const sessionHash = session ? await sha256Hex(session.sid) : null;
	await storeChallenge(bucket, options.challenge, purpose, sessionHash, now);
	return options;
}

// Verifies the assertion against the stored credential and advances its counter. Returns the owner
// as it was when the assertion was accepted.
async function verifyAssertion(
	bucket: R2Bucket,
	request: Request,
	purpose: 'login' | 'reauth',
	session: LoadedSession | null,
	body: { challenge: string; response: AuthenticationResponseJSON },
	now: number,
	pinnedRpId?: string,
): Promise<OwnerRecord> {
	const sessionHash = session ? await sha256Hex(session.sid) : null;
	await consumeChallenge(bucket, body.challenge, purpose, sessionHash, now);

	const owner = await loadOwnerOrThrow(bucket, invalidSignIn);
	const stored = owner.methods.passkey.credentials.find((credential) => credential.id === body.response?.id);
	if (!stored || (purpose === 'login' && !isUsable(owner, 'passkey'))) {
		throw invalidSignIn();
	}

	const { rpID, origin } = relyingParty(request, pinnedRpId);
	const verification = await verifyAuthenticationResponse({
		response: body.response,
		expectedChallenge: body.challenge,
		expectedOrigin: origin,
		expectedRPID: rpID,
		requireUserVerification: true,
		credential: {
			id: stored.id,
			publicKey: new Uint8Array(fromBase64Url(stored.publicKey)),
			counter: stored.counter,
			transports: stored.transports as AuthenticatorTransport[],
		},
	}).catch(() => null);
	if (!verification?.verified) {
		throw invalidSignIn();
	}

	const newCounter = verification.authenticationInfo.newCounter;
	const credentialId = stored.id;
	try {
		return await mutateOwner(bucket, (latest) => {
			const current = latest.methods.passkey.credentials.find((credential) => credential.id === credentialId);
			if (!current || (purpose === 'login' && !isUsable(latest, 'passkey'))) {
				throw new CredentialGoneError();
			}
			const credentials = latest.methods.passkey.credentials.map((credential) =>
				credential.id === credentialId ? { ...credential, counter: newCounter, lastUsedAt: now } : credential,
			);
			return { ...latest, methods: { ...latest.methods, passkey: { ...latest.methods.passkey, credentials } } };
		});
	} catch (error) {
		if (error instanceof CredentialGoneError) {
			throw invalidSignIn();
		}
		if (error instanceof OwnerConflictError) {
			throw new ApiError(409, 'CONFLICT', 'Sign-in is busy, try again');
		}
		throw error;
	}
}

export async function loginVerify(
	bucket: R2Bucket,
	request: Request,
	body: { challenge: string; response: AuthenticationResponseJSON },
	now: number,
	pinnedRpId?: string,
) {
	return verifyAssertion(bucket, request, 'login', null, body, now, pinnedRpId);
}

export async function reauthVerify(
	bucket: R2Bucket,
	request: Request,
	session: LoadedSession,
	body: { challenge: string; response: AuthenticationResponseJSON },
	now: number,
	pinnedRpId?: string,
): Promise<void> {
	await verifyAssertion(bucket, request, 'reauth', session, body, now, pinnedRpId);
	await markReauthenticated(bucket, session.sid, now, 'passkey');
}
