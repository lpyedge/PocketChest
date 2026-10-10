import type { MessageKey } from '../i18n';

// A failure the interface can show. `key` is a message key; `code` is the server's stable code, when there is one.
// Server text is never shown: the code is looked up in the local message table instead.
export class ClientError extends Error {
	constructor(
		readonly key: MessageKey,
		readonly code?: string,
	) {
		super(key);
	}
}

const CODE_KEYS: Record<string, MessageKey> = {
	CHEST_NOT_FOUND: 'error.codeNotFound',
	SESSION_NOT_FOUND: 'error.sessionNotFound',
	UPLOAD_IN_PROGRESS: 'error.uploadInProgress',
	TOO_MANY_FILES: 'error.tooManyFiles',
	SESSION_QUOTA_EXCEEDED: 'error.quotaExceeded',
	FILE_TOO_LARGE: 'error.fileTooLarge',
	COMPLETION_MISMATCH: 'error.completionMismatch',
	UPLOAD_LEASE_LOST: 'error.leaseLost',
	AUTH_REQUIRED: 'error.signInRequired',
	AUTH_INVALID: 'error.signInRequired',
	RATE_LIMITED: 'error.rateLimited',
	INVALID_REQUEST: 'error.invalidRequest',
	AUTH_INVALID_CREDENTIALS: 'code.AUTH_INVALID_CREDENTIALS',
	AUTH_METHOD_DISABLED: 'code.AUTH_METHOD_DISABLED',
	AUTH_METHOD_NOT_CONFIGURED: 'code.AUTH_METHOD_NOT_CONFIGURED',
	CSRF_REJECTED: 'code.CSRF_REJECTED',
	CONFLICT: 'code.CONFLICT',
	REAUTH_REQUIRED: 'code.REAUTH_REQUIRED',
	REAUTH_METHOD_REQUIRED: 'code.REAUTH_METHOD_REQUIRED',
	ACTIVATION_PROOF_REQUIRED: 'code.ACTIVATION_PROOF_REQUIRED',
	LAST_AUTH_METHOD: 'code.LAST_AUTH_METHOD',
	PASSKEY_ALREADY_REGISTERED: 'code.PASSKEY_ALREADY_REGISTERED',
	PASSKEY_VERIFY_FAILED: 'code.PASSKEY_VERIFY_FAILED',
	PASSKEY_NOT_FOUND: 'code.PASSKEY_NOT_FOUND',
	CHALLENGE_INVALID: 'code.CHALLENGE_INVALID',
	TOTP_CODE_INVALID: 'code.TOTP_CODE_INVALID',
	PASSWORD_MISMATCH: 'code.PASSWORD_MISMATCH',
	PASSWORD_TOO_SHORT: 'code.PASSWORD_TOO_SHORT',
	PASSWORD_TOO_LONG: 'code.PASSWORD_TOO_LONG',
	PASSWORD_TOO_WEAK: 'code.PASSWORD_TOO_WEAK',
	PASSWORD_UNCHANGED: 'code.PASSWORD_UNCHANGED',
	SHARE_NOT_FOUND: 'code.SHARE_NOT_FOUND',
	EXPIRY_NOT_LATER: 'code.EXPIRY_NOT_LATER',
	SHARE_EXPIRED: 'code.SHARE_EXPIRED',
};

// The message key for a server code, if the interface has one
export function codeKeyFor(code: string | undefined): MessageKey | undefined {
	return code ? CODE_KEYS[code] : undefined;
}

// Picks the message for a failure: the server code when it has one, otherwise the call's own message
export function messageKeyFor(error: unknown): MessageKey {
	if (error instanceof ClientError) {
		return codeKeyFor(error.code) ?? error.key;
	}
	return 'error.generic';
}

// Failed response: keeps the server's stable code (the text is discarded) so the right message can be shown
export async function failureFrom(response: Response, key: MessageKey): Promise<ClientError> {
	const body = (await response.json().catch(() => ({}))) as { code?: unknown };
	return new ClientError(key, typeof body.code === 'string' ? body.code : undefined);
}
