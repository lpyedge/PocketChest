// Sign-in and owner security calls. Cookies travel with same-origin requests on their own; the CSRF token
// (returned by sign-in and rotated by security changes) is echoed in a header on every change.

export interface AuthMethodsStatus {
	setupRequired: boolean;
	methods: { password: { enabled: boolean }; totp: { enabled: boolean }; passkey: { enabled: boolean } };
}

export interface SecurityStatus {
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

export interface Rotation {
	security: SecurityStatus;
	csrfToken: string;
}

// A failed call: the status, the stable code, and how long to wait when the server asked for it
export class AuthRequestError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly retryAfter: number | null,
	) {
		super(message);
	}
}

async function call<T>(method: string, path: string, options: { csrf?: string; body?: unknown } = {}): Promise<T> {
	const headers: Record<string, string> = {};
	if (options.body !== undefined) headers['Content-Type'] = 'application/json';
	if (options.csrf) headers['X-PocketChest-CSRF'] = options.csrf;
	const response = await fetch(path, {
		method,
		headers,
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	});
	const data = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
	if (!response.ok) {
		const retry = Number(response.headers.get('Retry-After'));
		throw new AuthRequestError(
			response.status,
			data.code ?? 'UNKNOWN',
			data.error ?? 'Something went wrong',
			Number.isFinite(retry) && retry > 0 ? retry : null,
		);
	}
	return data as T;
}

export const authApi = {
	methods: () => call<AuthMethodsStatus>('GET', '/api/auth/methods'),
	session: () => call<{ authenticated: boolean; csrfToken?: string }>('GET', '/api/auth/session'),
	bootstrap: (password: string) => call<{ initialized: boolean }>('POST', '/api/auth/bootstrap', { body: { password } }),
	loginPassword: (password: string) => call<{ csrfToken: string }>('POST', '/api/auth/login/password', { body: { password } }),
	loginTotp: (code: string) => call<{ csrfToken: string }>('POST', '/api/auth/login/totp', { body: { code } }),
	passkeyLoginOptions: () => call<any>('POST', '/api/auth/passkey/login/options', { body: {} }),
	passkeyLoginVerify: (challenge: string, response: unknown) =>
		call<{ csrfToken: string }>('POST', '/api/auth/passkey/login/verify', { body: { challenge, response } }),
	logout: (csrf: string) => call<{ signedOut: boolean }>('POST', '/api/auth/logout', { csrf, body: {} }),

	security: () => call<SecurityStatus>('GET', '/api/admin/security'),
	setMethod: (csrf: string, method: 'password' | 'totp' | 'passkey', enabled: boolean) =>
		call<Rotation>('PATCH', '/api/admin/security/methods', { csrf, body: { method, enabled } }),
	changePassword: (csrf: string, newPassword: string, confirmPassword: string) =>
		call<Rotation>('POST', '/api/admin/security/password', { csrf, body: { newPassword, confirmPassword } }),
	totpPrepare: (csrf: string) =>
		call<{ challenge: string; otpauthUri: string; expiresIn: number }>('POST', '/api/admin/security/totp/prepare', { csrf, body: {} }),
	totpConfirm: (csrf: string, challenge: string, code: string) =>
		call<Rotation>('POST', '/api/admin/security/totp/confirm', { csrf, body: { challenge, code } }),
	passkeyRegisterOptions: (csrf: string) => call<any>('POST', '/api/admin/passkeys/register/options', { csrf, body: {} }),
	passkeyRegisterVerify: (csrf: string, challenge: string, response: unknown, label: string) =>
		call<{ registered: boolean }>('POST', '/api/admin/passkeys/register/verify', { csrf, body: { challenge, response, label } }),
	passkeyRemove: (csrf: string, id: string) => call<Rotation>('DELETE', `/api/admin/passkeys/${encodeURIComponent(id)}`, { csrf }),

	reauthPassword: (csrf: string, password: string) =>
		call<{ reauthenticated: boolean }>('POST', '/api/auth/reauth/password', { csrf, body: { password } }),
	reauthTotp: (csrf: string, code: string) => call<{ reauthenticated: boolean }>('POST', '/api/auth/reauth/totp', { csrf, body: { code } }),
	reauthPasskeyOptions: (csrf: string) => call<any>('POST', '/api/auth/reauth/passkey/options', { csrf, body: {} }),
	reauthPasskeyVerify: (csrf: string, challenge: string, response: unknown) =>
		call<{ reauthenticated: boolean }>('POST', '/api/auth/reauth/passkey/verify', { csrf, body: { challenge, response } }),

	// Proof of holding a method that is switched off, to switch it on again. Not a re-entry.
	activatePassword: (csrf: string, password: string) =>
		call<{ proven: boolean }>('POST', '/api/auth/activate/password', { csrf, body: { password } }),
	activateTotp: (csrf: string, code: string) => call<{ proven: boolean }>('POST', '/api/auth/activate/totp', { csrf, body: { code } }),
	activatePasskeyOptions: (csrf: string) => call<any>('POST', '/api/auth/activate/passkey/options', { csrf, body: {} }),
	activatePasskeyVerify: (csrf: string, challenge: string, response: unknown) =>
		call<{ proven: boolean }>('POST', '/api/auth/activate/passkey/verify', { csrf, body: { challenge, response } }),
};
