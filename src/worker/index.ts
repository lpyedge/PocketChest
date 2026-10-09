import { assertSameOrigin, clearedSessionCookie, csrfTokenFor, issueOwnerSession, requireOwner } from './auth/sessions';
import { bootstrapOwner } from './auth/bootstrap';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { authMethods, loginWithPassword, loginWithTotp, reauthWithPassword, reauthWithTotp } from './auth/login';
import { assertionOptions, loginVerify, registrationOptions, registrationVerify, reauthVerify } from './auth/passkeys';
import { changePassword, confirmTotp, prepareTotp, removePasskey, Rotated, securityStatus, setMethodEnabled } from './auth/security';
import type { Method } from './auth/owner';
import { ApiError } from './errors';
import { enforceRateLimit } from './ratelimit';
import {
	abandonSession,
	acquireLease,
	assertSameCompletion,
	beginFinalize,
	getSessionRecord,
	MultipartUploadEntry,
	registerMultipartUpload,
	releaseLease,
	setLeaseUsage,
	SessionError,
	SessionRecord,
	transitionSession,
} from './session';
import { LIMITS, utf8ByteLength } from './limits';
import {
	Env,
	CreateChestResponse,
	UploadFileResponse,
	CompleteUploadRequest,
	CompleteUploadResponse,
	RetrieveChestResponse,
	CreateMultipartUploadRequest,
	CreateMultipartUploadResponse,
	UploadPartResponse,
	CompleteMultipartUploadRequest,
	CompleteMultipartUploadResponse,
	ChestFile,
	UploadJWTPayload,
	MultipartJWTPayload,
} from './types';
import {
	generateUUID,
	createUploadJWT,
	createChestJWT,
	verifyUploadJWT,
	verifyChestJWT,
	createDownloadJWT,
	verifyDownloadJWT,
	DOWNLOAD_COOKIE_SECONDS,
	createMultipartJWT,
	verifyMultipartJWT,
	isValidUUID,
	isValidRetrievalCode,
	calculateExpiry,
	getCurrentTimestamp,
	isValidValidityDays,
	contentDisposition,
} from './utils';
import {
	cleanupExpired,
	finalizeChest,
	fileKey,
	fileUploadOptions,
	getChest,
	isSessionOpen,
	openSession,
	abortActiveMultipart,
	finalizingIndexKey,
	StorageVerificationError,
	verifyStoredFile,
} from './storage';

// Error responses: { "error": human-readable message, "code": stable machine-readable code }
// A write lease lasts this long; a write that outlives it can no longer register its file
const UPLOAD_LEASE_SECONDS = 15 * 60;

function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'Content-Type': 'application/json', ...extraHeaders },
	});
}

// Maps session state errors to stable API codes; internal details are never returned
function sessionErrorToApi(error: SessionError): ApiError {
	switch (error.code) {
		case 'NOT_FOUND':
		case 'NOT_OPEN':
			return new ApiError(404, 'SESSION_NOT_FOUND', 'Session not found or already completed');
		case 'LEASE_ACTIVE':
			return new ApiError(409, 'UPLOAD_IN_PROGRESS', 'Uploads are still in progress; try again shortly');
		case 'QUOTA_FILES':
			return new ApiError(413, 'TOO_MANY_FILES', 'This upload session has reached its file limit');
		case 'QUOTA_BYTES':
			return new ApiError(413, 'SESSION_QUOTA_EXCEEDED', 'This upload session has reached its size limit');
		case 'COMPLETION_MISMATCH':
			return new ApiError(409, 'COMPLETION_MISMATCH', 'This upload was already completed with different files or validity');
		case 'LEASE_LOST':
			return new ApiError(409, 'UPLOAD_LEASE_LOST', 'The upload expired before it finished; please upload again');
		case 'CORRUPT_RECORD':
			console.error('Corrupt session record');
			return new ApiError(500, 'INTERNAL_ERROR', 'Internal Server Error');
		default:
			return new ApiError(409, 'CONFLICT', 'Session state changed, try again');
	}
}

function errorResponse(error: ApiError): Response {
	return json({ error: error.message, code: error.code }, error.status, error.headers);
}

export default {
	async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		// Static assets normally never reach the Worker (run_worker_first only covers /api/*)
		if (path !== '/api' && !path.startsWith('/api/')) {
			return env.ASSETS.fetch(request);
		}

		return withApiHeaders(await routeApi(request, env, path));
	},

	// Scheduled event handler (cron job)
	async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
		console.log('🧹 Starting scheduled cleanup job at', new Date().toISOString());

		const result = await cleanupExpired(env.R2_STORAGE, getCurrentTimestamp());
		const { errors, ...counts } = result;
		console.log('🧹 Cleanup summary:', JSON.stringify(counts));

		// Partial failures are kept and retried by the next run; the invocation is still reported as failed
		// so that the problem shows up in the Worker's logs and observability
		if (errors.length > 0) {
			console.error(`❌ Cleanup finished with ${errors.length} error(s):`, errors.slice(0, 20).join(' | '));
			throw new Error(`Cleanup finished with ${errors.length} error(s); remaining work will be retried`);
		}
		console.log('✅ Cleanup completed without errors');
	},
} satisfies ExportedHandler<Env>;

// Every API response: never cached, never sniffed, no referrer
function withApiHeaders(response: Response): Response {
	const headers = new Headers(response.headers);
	headers.set('Cache-Control', 'no-store');
	headers.set('X-Content-Type-Options', 'nosniff');
	headers.set('Referrer-Policy', 'no-referrer');
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function routeApi(request: Request, env: Env, path: string): Promise<Response> {
	const segments = path.split('/');
	const method = request.method;

	try {
		if (path === '/api/auth/bootstrap' && method === 'POST') {
			return await handleBootstrap(request, env);
		}

		if (path === '/api/auth/session' && method === 'GET') {
			return await handleOwnerSessionStatus(request, env);
		}

		if (path === '/api/auth/logout' && method === 'POST') {
			return await handleLogout(request, env);
		}

		if (path === '/api/auth/methods' && method === 'GET') {
			return await handleAuthMethods(env);
		}

		if (path === '/api/auth/login/password' && method === 'POST') {
			return await handlePasswordLogin(request, env);
		}

		if (path === '/api/auth/reauth/password' && method === 'POST') {
			return await handlePasswordReauth(request, env);
		}

		if (path === '/api/admin/security' && method === 'GET') {
			return await handleSecurityStatus(request, env);
		}

		if (path === '/api/admin/security/methods' && method === 'PATCH') {
			return await handleSetMethod(request, env);
		}

		if (path === '/api/admin/security/password' && method === 'POST') {
			return await handleChangePassword(request, env);
		}

		if (path === '/api/admin/security/totp/prepare' && method === 'POST') {
			return await handlePrepareTotp(request, env);
		}

		if (path === '/api/admin/security/totp/confirm' && method === 'POST') {
			return await handleConfirmTotp(request, env);
		}

		if (path.match(/^\/api\/admin\/passkeys\/[^\/]+$/) && method === 'DELETE') {
			return await handleRemovePasskey(request, env, segments[4]);
		}

		if (path === '/api/admin/passkeys/register/options' && method === 'POST') {
			return await handlePasskeyRegisterOptions(request, env);
		}

		if (path === '/api/admin/passkeys/register/verify' && method === 'POST') {
			return await handlePasskeyRegisterVerify(request, env);
		}

		if (path === '/api/auth/passkey/login/options' && method === 'POST') {
			return await handlePasskeyLoginOptions(request, env);
		}

		if (path === '/api/auth/passkey/login/verify' && method === 'POST') {
			return await handlePasskeyLoginVerify(request, env);
		}

		if (path === '/api/auth/reauth/passkey/options' && method === 'POST') {
			return await handlePasskeyReauthOptions(request, env);
		}

		if (path === '/api/auth/reauth/passkey/verify' && method === 'POST') {
			return await handlePasskeyReauthVerify(request, env);
		}

		if (path === '/api/auth/login/totp' && method === 'POST') {
			return await handleTotpLogin(request, env);
		}

		if (path === '/api/auth/reauth/totp' && method === 'POST') {
			return await handleTotpReauth(request, env);
		}

		if (path === '/api/upload-sessions' && method === 'POST') {
			return await handleCreateUploadSession(request, env);
		}

		if (path.match(/^\/api\/upload-sessions\/[^\/]+\/files$/) && method === 'POST') {
			return await handleUploadFiles(request, env, segments[3]);
		}

		if (path.match(/^\/api\/upload-sessions\/[^\/]+\/multipart\/create$/) && method === 'POST') {
			return await handleCreateMultipartUpload(request, env, segments[3]);
		}

		if (path.match(/^\/api\/upload-sessions\/[^\/]+\/multipart\/[^\/]+\/parts\/[^\/]+$/) && method === 'PUT') {
			return await handleUploadPart(request, env, segments[3], segments[5], parseInt(segments[7]));
		}

		if (path.match(/^\/api\/upload-sessions\/[^\/]+\/multipart\/[^\/]+\/abort$/) && method === 'POST') {
			return await handleAbortMultipartUpload(request, env, segments[3], segments[5]);
		}

		if (path.match(/^\/api\/upload-sessions\/[^\/]+\/multipart\/[^\/]+\/complete$/) && method === 'POST') {
			return await handleCompleteMultipartUpload(request, env, segments[3], segments[5]);
		}

		if (path.match(/^\/api\/upload-sessions\/[^\/]+\/cancel$/) && method === 'POST') {
			return await handleCancelUpload(request, env, segments[3]);
		}

		if (path.match(/^\/api\/upload-sessions\/[^\/]+\/complete$/) && method === 'POST') {
			return await handleCompleteUpload(request, env, segments[3]);
		}

		if (path === '/api/retrieve' && method === 'POST') {
			return await handleRetrieveChest(request, env);
		}

		if (path === '/api/download/authorize' && method === 'POST') {
			return await handleAuthorizeDownload(request, env);
		}

		if (path.match(/^\/api\/download\/[^\/]+$/) && method === 'GET') {
			return await handleDownloadFile(request, env, segments[3]);
		}

		return errorResponse(new ApiError(404, 'NOT_FOUND', 'Not Found'));
	} catch (error) {
		if (error instanceof ApiError) {
			return errorResponse(error);
		}
		if (error instanceof SessionError) {
			return errorResponse(sessionErrorToApi(error));
		}
		console.error('Error:', error);
		return errorResponse(new ApiError(500, 'INTERNAL_ERROR', 'Internal Server Error'));
	}
}

// POST /api/auth/bootstrap - Initial owner setup (one time)
async function handleBootstrap(request: Request, env: Env): Promise<Response> {
	assertSameOrigin(request);
	await enforceRateLimit(env.AUTH_LIMITER, request, 'bootstrap');
	const { password } = await readJson<{ password?: unknown }>(request);
	if (typeof password !== 'string' || password.length === 0 || password.length > 1024) {
		throw new ApiError(400, 'INVALID_REQUEST', 'Password is required');
	}
	await bootstrapOwner(env, password);
	return json({ initialized: true }, 201, { 'Cache-Control': 'no-store' });
}

// GET /api/auth/session - Whether the caller is signed in as the owner, and the CSRF token for this session
async function handleOwnerSessionStatus(request: Request, env: Env): Promise<Response> {
	try {
		const session = await requireOwner(request, env.R2_STORAGE, env.JWT_SECRET, { mutating: false });
		return json({ authenticated: true, csrfToken: await csrfTokenFor(env.JWT_SECRET, session.sid) }, 200, { 'Cache-Control': 'no-store' });
	} catch (error) {
		if (error instanceof ApiError && error.status === 401) {
			return json({ authenticated: false });
		}
		throw error;
	}
}

// POST /api/auth/logout - Ends the current owner session and clears its cookie
async function handleLogout(request: Request, env: Env): Promise<Response> {
	const session = await requireOwner(request, env.R2_STORAGE, env.JWT_SECRET, { mutating: true });
	await env.R2_STORAGE.delete(session.key);
	return json({ signedOut: true }, 200, { 'Set-Cookie': clearedSessionCookie() });
}

// --- Request helpers ---

function bearerToken(request: Request): string {
	const authHeader = request.headers.get('Authorization');
	if (!authHeader || !authHeader.startsWith('Bearer ')) {
		throw new ApiError(401, 'AUTH_REQUIRED', 'Unauthorized');
	}
	return authHeader.substring(7);
}

async function readJson<T>(request: Request): Promise<T> {
	try {
		return await request.json();
	} catch {
		throw new ApiError(400, 'INVALID_REQUEST', 'Invalid JSON body');
	}
}

// Verifies the upload token for a session and that the session is still open
// Checks the upload token and that it belongs to this session, whatever state the session is in
async function authorizeUploadToken(request: Request, env: Env, sessionId: string): Promise<UploadJWTPayload> {
	const token = bearerToken(request);
	let payload: UploadJWTPayload;
	try {
		payload = await verifyUploadJWT(token, env.JWT_SECRET);
	} catch {
		throw new ApiError(401, 'AUTH_INVALID', 'Invalid token');
	}

	if (payload.sessionId !== sessionId || !isValidUUID(sessionId)) {
		throw new ApiError(400, 'INVALID_SESSION', 'Invalid session');
	}
	return payload;
}

async function authorizeUpload(request: Request, env: Env, sessionId: string): Promise<UploadJWTPayload> {
	const token = bearerToken(request);
	let payload: UploadJWTPayload;
	try {
		payload = await verifyUploadJWT(token, env.JWT_SECRET);
	} catch {
		throw new ApiError(401, 'AUTH_INVALID', 'Invalid token');
	}

	if (payload.sessionId !== sessionId || !isValidUUID(sessionId)) {
		throw new ApiError(400, 'INVALID_SESSION', 'Invalid session');
	}

	if (!(await isSessionOpen(env.R2_STORAGE, sessionId))) {
		throw new ApiError(404, 'SESSION_NOT_FOUND', 'Session not found or already completed');
	}

	return payload;
}

async function authorizeMultipart(request: Request, env: Env, sessionId: string, fileId: string): Promise<MultipartJWTPayload> {
	const token = bearerToken(request);
	let payload: MultipartJWTPayload;
	try {
		payload = await verifyMultipartJWT(token, env.JWT_SECRET);
	} catch {
		throw new ApiError(401, 'AUTH_INVALID', 'Invalid multipart token');
	}

	if (payload.sessionId !== sessionId || payload.fileId !== fileId) {
		throw new ApiError(403, 'TOKEN_MISMATCH', 'Token does not match upload session');
	}

	if (!isValidUUID(sessionId) || !isValidUUID(fileId)) {
		throw new ApiError(400, 'INVALID_REQUEST', 'Invalid session or file ID format');
	}

	return payload;
}

// --- Handlers ---

// GET /api/auth/methods - Which sign-in methods are usable, and whether first-time setup is open
async function handleAuthMethods(env: Env): Promise<Response> {
	return json(await authMethods(env), 200, { 'Cache-Control': 'no-store' });
}

// POST /api/auth/login/password - Starts an owner session when the password is correct
async function handlePasswordLogin(request: Request, env: Env): Promise<Response> {
	assertSameOrigin(request);
	await enforceRateLimit(env.AUTH_LIMITER, request, 'login-password');
	const { password } = await readJson<{ password?: unknown }>(request);
	if (typeof password !== 'string' || password.length === 0 || password.length > 1024) {
		throw new ApiError(401, 'AUTH_INVALID_CREDENTIALS', 'Invalid credentials');
	}
	const issued = await loginWithPassword(env, password, getCurrentTimestamp());
	return json({ authenticated: true, csrfToken: issued.csrfToken }, 200, { 'Set-Cookie': issued.cookie });
}

// POST /api/auth/reauth/password - Re-enters the password inside a signed-in session
async function handlePasswordReauth(request: Request, env: Env): Promise<Response> {
	const session = await requireOwner(request, env.R2_STORAGE, env.JWT_SECRET, { mutating: true });
	await enforceRateLimit(env.AUTH_LIMITER, request, 'reauth-password');
	const { password } = await readJson<{ password?: unknown }>(request);
	if (typeof password !== 'string' || password.length === 0 || password.length > 1024) {
		throw new ApiError(401, 'AUTH_INVALID_CREDENTIALS', 'Invalid credentials');
	}
	await reauthWithPassword(env, session, password, getCurrentTimestamp());
	return json({ reauthenticated: true }, 200, { 'Cache-Control': 'no-store' });
}

// Reads the six-digit code; anything malformed gets the same answer as a wrong code
async function readTotpCode(request: Request): Promise<string> {
	const { code } = await readJson<{ code?: unknown }>(request).catch(() => ({ code: undefined }));
	return typeof code === 'string' ? code : '';
}

// POST /api/auth/login/totp - Starts an owner session with an authenticator code, no password needed
async function handleTotpLogin(request: Request, env: Env): Promise<Response> {
	assertSameOrigin(request);
	await enforceRateLimit(env.AUTH_LIMITER, request, 'login-totp');
	const code = await readTotpCode(request);
	const issued = await loginWithTotp(env, code, getCurrentTimestamp());
	return json({ authenticated: true, csrfToken: issued.csrfToken }, 200, { 'Set-Cookie': issued.cookie });
}

// POST /api/auth/reauth/totp - Re-enters an authenticator code inside a signed-in session
async function handleTotpReauth(request: Request, env: Env): Promise<Response> {
	const session = await requireOwner(request, env.R2_STORAGE, env.JWT_SECRET, { mutating: true });
	await enforceRateLimit(env.AUTH_LIMITER, request, 'reauth-totp');
	const code = await readTotpCode(request);
	await reauthWithTotp(env, session, code, getCurrentTimestamp());
	return json({ reauthenticated: true }, 200, { 'Cache-Control': 'no-store' });
}

// --- Security settings (signed-in owner) ---

// A change that bumps authVersion answers with the replacement session, so the caller stays signed in
function rotatedResponse(result: Rotated): Response {
	return json({ security: result.security, csrfToken: result.csrfToken }, 200, {
		'Cache-Control': 'no-store',
		'Set-Cookie': result.cookie,
	});
}

// GET /api/admin/security - Which methods are set up and on; never the secrets themselves
async function handleSecurityStatus(request: Request, env: Env): Promise<Response> {
	await requireOwner(request, env.R2_STORAGE, env.JWT_SECRET, { mutating: false });
	return json(await securityStatus(env.R2_STORAGE), 200, { 'Cache-Control': 'no-store' });
}

// PATCH /api/admin/security/methods - Switches one method on or off
async function handleSetMethod(request: Request, env: Env): Promise<Response> {
	const session = await requireOwner(request, env.R2_STORAGE, env.JWT_SECRET, { mutating: true });
	const body = await readJson<{ method?: unknown; enabled?: unknown }>(request);
	if ((body.method !== 'password' && body.method !== 'totp' && body.method !== 'passkey') || typeof body.enabled !== 'boolean') {
		throw new ApiError(400, 'INVALID_REQUEST', 'A method and an enabled flag are required');
	}
	const result = await setMethodEnabled(env, session, body.method as Method, body.enabled, getCurrentTimestamp());
	return rotatedResponse(result);
}

// POST /api/admin/security/password - Changes the password; every other session ends
async function handleChangePassword(request: Request, env: Env): Promise<Response> {
	const session = await requireOwner(request, env.R2_STORAGE, env.JWT_SECRET, { mutating: true });
	const body = await readJson<{ newPassword?: unknown; confirmPassword?: unknown }>(request);
	const result = await changePassword(env, session, body.newPassword, body.confirmPassword, getCurrentTimestamp());
	return rotatedResponse(result);
}

// POST /api/admin/security/totp/prepare - A new seed, kept sealed until it is confirmed
async function handlePrepareTotp(request: Request, env: Env): Promise<Response> {
	const session = await requireOwner(request, env.R2_STORAGE, env.JWT_SECRET, { mutating: true });
	const prepared = await prepareTotp(env, session, getCurrentTimestamp());
	return json(prepared, 200, { 'Cache-Control': 'no-store' });
}

// POST /api/admin/security/totp/confirm - Replaces the seed once the new code is checked
async function handleConfirmTotp(request: Request, env: Env): Promise<Response> {
	const session = await requireOwner(request, env.R2_STORAGE, env.JWT_SECRET, { mutating: true });
	await enforceRateLimit(env.AUTH_LIMITER, request, 'totp-confirm');
	const body = await readJson<{ challenge?: unknown; code?: unknown }>(request);
	if (typeof body.challenge !== 'string' || typeof body.code !== 'string') {
		throw new ApiError(400, 'INVALID_REQUEST', 'A challenge and a code are required');
	}
	const result = await confirmTotp(env, session, body.challenge, body.code, getCurrentTimestamp());
	return rotatedResponse(result);
}

// DELETE /api/admin/passkeys/:id - Removes one passkey
async function handleRemovePasskey(request: Request, env: Env, credentialId: string): Promise<Response> {
	const session = await requireOwner(request, env.R2_STORAGE, env.JWT_SECRET, { mutating: true });
	const result = await removePasskey(env, session, decodeURIComponent(credentialId), getCurrentTimestamp());
	return rotatedResponse(result);
}

// --- Passkeys ---

// The body of a verify call: the one-time challenge and the authenticator's response
async function readPasskeyBody<T>(request: Request): Promise<T & { challenge: string }> {
	const body = await readJson<{ challenge?: unknown; response?: unknown }>(request);
	if (typeof body.challenge !== 'string' || typeof body.response !== 'object' || body.response === null) {
		throw new ApiError(400, 'INVALID_REQUEST', 'A challenge and a response are required');
	}
	return body as T & { challenge: string };
}

// POST /api/admin/passkeys/register/options - Owner, with a recent re-entry, starts registering a passkey
async function handlePasskeyRegisterOptions(request: Request, env: Env): Promise<Response> {
	const session = await requireOwner(request, env.R2_STORAGE, env.JWT_SECRET, { mutating: true });
	await enforceRateLimit(env.AUTH_LIMITER, request, 'passkey-register-options');
	const options = await registrationOptions(env.R2_STORAGE, request, session, getCurrentTimestamp(), env.PASSKEY_RP_ID);
	return json(options, 200, { 'Cache-Control': 'no-store' });
}

// POST /api/admin/passkeys/register/verify - Stores the new passkey's public key
async function handlePasskeyRegisterVerify(request: Request, env: Env): Promise<Response> {
	const session = await requireOwner(request, env.R2_STORAGE, env.JWT_SECRET, { mutating: true });
	await enforceRateLimit(env.AUTH_LIMITER, request, 'passkey-register-verify');
	const body = await readPasskeyBody<{ label?: unknown; response: RegistrationResponseJSON }>(request);
	const result = await registrationVerify(env.R2_STORAGE, request, session, body, getCurrentTimestamp(), env.PASSKEY_RP_ID);
	return json({ registered: true, credentialId: result.credentialId }, 200, { 'Cache-Control': 'no-store' });
}

// POST /api/auth/passkey/login/options - Starts a passkey sign-in with a one-time challenge
async function handlePasskeyLoginOptions(request: Request, env: Env): Promise<Response> {
	assertSameOrigin(request);
	await enforceRateLimit(env.AUTH_LIMITER, request, 'passkey-login-options');
	const options = await assertionOptions(env.R2_STORAGE, request, 'login', null, getCurrentTimestamp(), env.PASSKEY_RP_ID);
	return json(options, 200, { 'Cache-Control': 'no-store' });
}

// POST /api/auth/passkey/login/verify - Starts an owner session when the passkey assertion is valid
async function handlePasskeyLoginVerify(request: Request, env: Env): Promise<Response> {
	assertSameOrigin(request);
	await enforceRateLimit(env.AUTH_LIMITER, request, 'passkey-login-verify');
	const body = await readPasskeyBody<{ response: AuthenticationResponseJSON }>(request);
	const now = getCurrentTimestamp();
	const owner = await loginVerify(env.R2_STORAGE, request, body, now, env.PASSKEY_RP_ID);
	const issued = await issueOwnerSession(env.R2_STORAGE, env.JWT_SECRET, owner.authVersion, now);
	return json({ authenticated: true, csrfToken: issued.csrfToken }, 200, { 'Set-Cookie': issued.cookie });
}

// POST /api/auth/reauth/passkey/options - Signed-in owner re-confirms with a passkey
async function handlePasskeyReauthOptions(request: Request, env: Env): Promise<Response> {
	const session = await requireOwner(request, env.R2_STORAGE, env.JWT_SECRET, { mutating: true });
	await enforceRateLimit(env.AUTH_LIMITER, request, 'passkey-reauth-options');
	const options = await assertionOptions(env.R2_STORAGE, request, 'reauth', session, getCurrentTimestamp(), env.PASSKEY_RP_ID);
	return json(options, 200, { 'Cache-Control': 'no-store' });
}

// POST /api/auth/reauth/passkey/verify - Opens the reauth window after a valid passkey assertion
async function handlePasskeyReauthVerify(request: Request, env: Env): Promise<Response> {
	const session = await requireOwner(request, env.R2_STORAGE, env.JWT_SECRET, { mutating: true });
	await enforceRateLimit(env.AUTH_LIMITER, request, 'passkey-reauth-verify');
	const body = await readPasskeyBody<{ response: AuthenticationResponseJSON }>(request);
	await reauthVerify(env.R2_STORAGE, request, session, body, getCurrentTimestamp(), env.PASSKEY_RP_ID);
	return json({ reauthenticated: true }, 200, { 'Cache-Control': 'no-store' });
}

// POST /api/upload-sessions - Owner starts an upload session and receives its upload token
async function handleCreateUploadSession(request: Request, env: Env): Promise<Response> {
	await requireOwner(request, env.R2_STORAGE, env.JWT_SECRET, { mutating: true });
	await enforceRateLimit(env.UPLOAD_LIMITER, request, 'create-session');

	const sessionId = generateUUID();
	const createdAt = getCurrentTimestamp();
	const uploadToken = await createUploadJWT(sessionId, env.JWT_SECRET, createdAt);
	await openSession(env.R2_STORAGE, sessionId, createdAt);

	const response: CreateChestResponse = {
		sessionId,
		uploadToken,
		expiresIn: 86400, // 24 hours
	};
	return json(response, 200, { 'Cache-Control': 'no-store' });
}

// POST /api/upload-sessions/:sessionId/files - Upload files
async function handleUploadFiles(request: Request, env: Env, sessionId: string): Promise<Response> {
	await enforceRateLimit(env.UPLOAD_LIMITER, request, 'upload-files');
	await authorizeUpload(request, env, sessionId);

	// A declared body size is checked before anything is read; the real size is checked after parsing
	const declaredBytes = declaredLength(request, LIMITS.maxUploadRequestBytes);

	// Reserve the session for this write before anything is stored, so Complete cannot race it
	const leaseId = generateUUID();
	await acquireLease(env.R2_STORAGE, sessionId, {
		id: leaseId,
		expiresAt: getCurrentTimestamp() + UPLOAD_LEASE_SECONDS,
		files: 0,
		bytes: declaredBytes,
	});

	const written: string[] = [];
	try {
		const formData = await readBoundedFormData(request, LIMITS.maxUploadRequestBytes);

		// Phase 1: validate every item. Nothing is written here, so a refusal leaves no object behind.
		type Planned = {
			fileId: string;
			size: number;
			filename: string;
			mimeType: string;
			isText: boolean;
			body: File | string;
		};
		const planned: Planned[] = [];

		for (const value of formData.getAll('files')) {
			if (value instanceof File) {
				const filename = value.name || 'unnamed-file';
				checkFilename(filename);
				if (value.size > LIMITS.maxSmallFileBytes) {
					throw new ApiError(413, 'FILE_TOO_LARGE', 'File is larger than the single-upload limit; use multipart upload');
				}
				planned.push({
					fileId: generateUUID(),
					size: value.size,
					filename,
					mimeType: value.type || 'application/octet-stream',
					isText: false,
					body: value,
				});
			}
		}

		for (const textItem of formData.getAll('textItems')) {
			if (typeof textItem === 'string') {
				let textData: { content?: unknown; filename?: unknown } | null;
				try {
					textData = JSON.parse(textItem);
				} catch {
					throw new ApiError(400, 'INVALID_REQUEST', 'Invalid text item');
				}
				if (typeof textData !== 'object' || textData === null || typeof textData.content !== 'string') {
					throw new ApiError(400, 'INVALID_REQUEST', 'Invalid text item');
				}
				const size = utf8ByteLength(textData.content);
				if (size > LIMITS.maxTextBytes) {
					throw new ApiError(413, 'TEXT_TOO_LARGE', 'Text is larger than the limit');
				}
				const filename = typeof textData.filename === 'string' && textData.filename ? textData.filename : `text-${Date.now()}.txt`;
				checkFilename(filename);
				planned.push({ fileId: generateUUID(), size, filename, mimeType: 'text/plain', isText: true, body: textData.content });
			}
		}

		// Phase 2: the real count and size replace the reservation; over-quota uploads are refused before any write
		await setLeaseUsage(env.R2_STORAGE, sessionId, leaseId, {
			files: planned.length,
			bytes: planned.reduce((sum, file) => sum + file.size, 0),
		});

		// Phase 3: write. Every started write is waited for, so nothing is still running when we clean up or return.
		const outcomes = await Promise.allSettled(
			planned.map((file) => {
				const key = fileKey(sessionId, file.fileId);
				written.push(key);
				const body = file.body instanceof File ? file.body.stream() : file.body;
				return env.R2_STORAGE.put(key, body, fileUploadOptions(file));
			}),
		);
		const failed = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
		if (failed) {
			throw failed.reason;
		}

		// Only size-checked files are registered; a file that is missing or truncated fails the whole upload
		const registered = await Promise.all(planned.map((file) => verifyStoredFile(env.R2_STORAGE, sessionId, file.fileId, file)));
		await releaseLease(env.R2_STORAGE, sessionId, leaseId, registered);

		const response: UploadFileResponse = {
			uploadedFiles: planned.map((file) => ({ fileId: file.fileId, filename: file.filename, isText: file.isText })),
		};
		return json(response);
	} catch (error) {
		// Remove what this request wrote (best effort; the orphan scan catches the rest), then free the lease
		if (written.length > 0) {
			await env.R2_STORAGE.delete(written).catch(() => undefined);
		}
		await releaseLease(env.R2_STORAGE, sessionId, leaseId, []).catch(() => undefined);
		throw error;
	}
}

/**
 * Reads a multipart body with an upper bound on the bytes actually received, whether or not the client
 * declared a Content-Length. Past the limit the stream is cut and the request is refused with 413.
 */
async function readBoundedFormData(request: Request, maxBytes: number): Promise<FormData> {
	if (request.body === null) {
		throw new ApiError(400, 'INVALID_REQUEST', 'Request body is required');
	}
	let received = 0;
	let exceeded = false;
	const counter = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			received += chunk.byteLength;
			if (received > maxBytes) {
				exceeded = true;
				controller.error(new Error('Request body is larger than the limit'));
				return;
			}
			controller.enqueue(chunk);
		},
	});
	const bounded = new Response(request.body.pipeThrough(counter), {
		headers: { 'Content-Type': request.headers.get('Content-Type') ?? '' },
	});
	try {
		return await bounded.formData();
	} catch {
		if (exceeded) {
			throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is larger than the limit');
		}
		throw new ApiError(400, 'INVALID_REQUEST', 'Invalid multipart body');
	}
}

// Declared Content-Length of a request. Missing is allowed (the body is checked after reading), too large is refused.
function declaredLength(request: Request, max: number): number {
	const header = request.headers.get('Content-Length');
	if (header === null) {
		return 0;
	}
	const bytes = Number(header);
	if (!Number.isInteger(bytes) || bytes < 0) {
		throw new ApiError(400, 'INVALID_REQUEST', 'Invalid Content-Length');
	}
	if (bytes > max) {
		throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is larger than the limit');
	}
	return bytes;
}

function checkFilename(filename: string): void {
	if (utf8ByteLength(filename) > LIMITS.maxFilenameBytes) {
		throw new ApiError(400, 'FILENAME_TOO_LONG', 'File name is too long');
	}
}

// POST /api/upload-sessions/:sessionId/complete - Complete upload and generate retrieval code
// POST /api/upload-sessions/:sessionId/cancel - Abandon an upload session; its unfinished multipart uploads are aborted
async function handleCancelUpload(request: Request, env: Env, sessionId: string): Promise<Response> {
	const token = await authorizeUploadToken(request, env, sessionId);
	// Read the uploads before abandoning: abandoning marks them closed, and they still have to be aborted in R2
	const before = await getSessionRecord(env.R2_STORAGE, sessionId);
	if (!before) {
		throw new ApiError(404, 'SESSION_NOT_FOUND', 'Session not found or already completed');
	}
	await abandonSession(env.R2_STORAGE, sessionId);
	await abortActiveMultipart(env.R2_STORAGE, sessionId, before.record.multipartUploads);
	return json({ cancelled: true, createdAt: token.iat });
}

// Completion requests are fingerprinted, so a repeat with the same files and validity returns the same result
function completionFingerprint(fileIds: string[], validityDays: number): string {
	return `${[...fileIds].sort().join(',')}|${validityDays}`;
}

async function handleCompleteUpload(request: Request, env: Env, sessionId: string): Promise<Response> {
	const payload = await authorizeUploadToken(request, env, sessionId);
	const { fileIds, validityDays } = await readJson<CompleteUploadRequest>(request);

	if (
		!Array.isArray(fileIds) ||
		fileIds.length === 0 ||
		!fileIds.every((fileId) => typeof fileId === 'string' && isValidUUID(fileId)) ||
		new Set(fileIds).size !== fileIds.length
	) {
		throw new ApiError(400, 'INVALID_REQUEST', 'Invalid file ID format');
	}

	if (!isValidValidityDays(validityDays)) {
		throw new ApiError(400, 'INVALID_REQUEST', 'Invalid validity period');
	}

	const bucket = env.R2_STORAGE;
	const fingerprint = completionFingerprint(fileIds, validityDays);

	// Other requests may move the session while we look at it, so re-read and try a few times
	for (let attempt = 0; attempt < 3; attempt++) {
		const current = await getSessionRecord(bucket, sessionId);
		if (!current || current.record.status === 'ABANDONED') {
			throw new ApiError(404, 'SESSION_NOT_FOUND', 'Session not found or already completed');
		}
		const record = current.record;

		if (record.status === 'COMPLETED') {
			assertSameCompletion(record, fingerprint);
			return completionResponse(record.retrievalCode as string, record.expiresAt);
		}

		let finalizing: SessionRecord;
		try {
			if (record.status === 'FINALIZING') {
				// An earlier attempt is unfinished, or a concurrent request is finishing it: resume with the same input
				assertSameCompletion(record, fingerprint);
				if (record.validityDays === null) {
					// No stored plan (should not happen); never invent a new expiry, let the cleanup job roll it back
					throw new ApiError(409, 'CONFLICT', 'Session state changed, try again');
				}
				finalizing = record;
			} else {
				// Index first: if we fail before the session moves, the cleanup job just removes this entry
				const startedAt = getCurrentTimestamp();
				await bucket.put(finalizingIndexKey(startedAt, sessionId), '');
				// The expiry is decided here, once, and stored with the state change
				finalizing = await beginFinalize(bucket, sessionId, fingerprint, startedAt, {
					validityDays,
					expiresAt: calculateExpiry(validityDays),
				});
			}
		} catch (error) {
			if (error instanceof SessionError && error.code === 'INVALID_TRANSITION') {
				continue; // another request changed the state first; re-read
			}
			throw error;
		}

		// No new part can start once the session is finalizing; unfinished multipart uploads are dropped now
		await abortActiveMultipart(bucket, sessionId, finalizing.multipartUploads);

		const registered = new Map(finalizing.files.map((file) => [file.fileId, file]));
		const files = fileIds.map((fileId) => registered.get(fileId));
		if (files.some((file) => file === undefined)) {
			await transitionSession(bucket, sessionId, 'OPEN', {
				completionFingerprint: null,
				candidateCode: null,
				validityDays: null,
				expiresAt: null,
			});
			throw new ApiError(400, 'FILE_NOT_IN_SESSION', 'Some files do not belong to this session');
		}

		if (files.every((file) => (file as ChestFile).size === 0)) {
			// Nothing to share: undo the completion and refuse it
			await transitionSession(bucket, sessionId, 'OPEN', {
				completionFingerprint: null,
				candidateCode: null,
				finalizeStartedAt: null,
				validityDays: null,
				expiresAt: null,
			});
			throw new ApiError(400, 'EMPTY_CHEST', 'Nothing to share: all files are empty');
		}

		// Always the value fixed when completion started, also on a retry
		const expiresAt = finalizing.expiresAt;
		const code = await finalizeChest(bucket, sessionId, {
			createdAt: payload.iat,
			files: files as ChestFile[],
			expiresAt,
			validityDays,
			fingerprint,
		}).catch((error) => {
			if (error instanceof SessionError && error.code === 'INVALID_TRANSITION') {
				return undefined; // completed by a concurrent request; handled below
			}
			throw error;
		});

		if (code === null) {
			throw new ApiError(500, 'CODE_GENERATION_FAILED', 'Failed to generate unique retrieval code');
		}
		if (code !== undefined) {
			return completionResponse(code, expiresAt);
		}
	}

	throw new ApiError(409, 'CONFLICT', 'Session state changed, try again');
}

function completionResponse(retrievalCode: string, expiresAt: number | null): Response {
	const response: CompleteUploadResponse = {
		retrievalCode,
		expiryDate: expiresAt ? new Date(expiresAt * 1000).toISOString() : null,
	};
	return json(response);
}

// POST /api/retrieve - Look up a chest. The code travels in the JSON body, never in the URL.
async function handleRetrieveChest(request: Request, env: Env): Promise<Response> {
	await enforceRateLimit(env.RETRIEVE_LIMITER, request, 'retrieve');
	const body = await readJson<{ code?: unknown }>(request);
	if (typeof body.code !== 'string') {
		throw new ApiError(400, 'INVALID_REQUEST', 'Retrieval code is required');
	}
	if (!isValidRetrievalCode(body.code)) {
		throw new ApiError(400, 'INVALID_CODE', 'Invalid retrieval code format');
	}

	const manifest = await getChest(env.R2_STORAGE, body.code, getCurrentTimestamp());
	if (!manifest) {
		throw new ApiError(404, 'CHEST_NOT_FOUND', 'Retrieval code not found or expired');
	}

	const response: RetrieveChestResponse = {
		files: manifest.files,
		chestToken: await createChestJWT(manifest.sessionId, body.code, manifest.expiresAt, env.JWT_SECRET),
		expiryDate: manifest.expiresAt ? new Date(manifest.expiresAt * 1000).toISOString() : null,
	};
	return json(response, 200, { 'Cache-Control': 'no-store' });
}

const DOWNLOAD_COOKIE_PREFIX = 'pc_dl_';

function downloadCookieName(fileId: string): string {
	return `${DOWNLOAD_COOKIE_PREFIX}${fileId}`;
}

// Reads one cookie by name from a Cookie header
function cookieValue(header: string | null, name: string): string | null {
	for (const part of (header ?? '').split(';')) {
		const [key, ...rest] = part.trim().split('=');
		if (key === name) {
			return rest.join('=');
		}
	}
	return null;
}

// POST /api/download/authorize - Trade the retrieval token for a download Cookie for one file
async function handleAuthorizeDownload(request: Request, env: Env): Promise<Response> {
	await enforceRateLimit(env.RETRIEVE_LIMITER, request, 'download-authorize');
	let chest;
	try {
		chest = await verifyChestJWT(bearerToken(request), env.JWT_SECRET);
	} catch (error) {
		if (error instanceof ApiError) throw error;
		throw new ApiError(401, 'AUTH_INVALID', 'Invalid token');
	}

	const { fileId } = await readJson<{ fileId?: unknown }>(request);
	if (typeof fileId !== 'string' || !isValidUUID(fileId)) {
		throw new ApiError(400, 'INVALID_REQUEST', 'Invalid file ID format');
	}

	const manifest = await getChest(env.R2_STORAGE, chest.code, getCurrentTimestamp());
	if (!manifest || manifest.sessionId !== chest.sessionId) {
		throw new ApiError(404, 'CHEST_NOT_FOUND', 'Retrieval code not found or expired');
	}
	if (!manifest.files.some((file) => file.fileId === fileId)) {
		throw new ApiError(404, 'FILE_NOT_FOUND', 'File not found in this chest');
	}

	const token = await createDownloadJWT({ sessionId: chest.sessionId, code: chest.code, fileId }, env.JWT_SECRET);
	// Path-scoped to this file, so the browser sends it only to this file's download URL
	const cookie = [
		`${downloadCookieName(fileId)}=${token}`,
		'HttpOnly',
		'Secure',
		'SameSite=Strict',
		`Path=/api/download/${fileId}`,
		`Max-Age=${DOWNLOAD_COOKIE_SECONDS}`,
	].join('; ');

	return json({ authorized: true, fileId }, 200, { 'Cache-Control': 'no-store', 'Set-Cookie': cookie });
}

// GET /api/download/:fileId - Stream one file. Authorized only by the download Cookie for that file.
async function handleDownloadFile(request: Request, env: Env, fileId: string): Promise<Response> {
	const token = cookieValue(request.headers.get('Cookie'), downloadCookieName(fileId));
	if (!token) {
		throw new ApiError(401, 'AUTH_REQUIRED', 'Download authorization required');
	}

	let claims;
	try {
		claims = await verifyDownloadJWT(token, env.JWT_SECRET);
	} catch {
		throw new ApiError(401, 'AUTH_INVALID', 'Download authorization expired');
	}
	if (claims.fileId !== fileId || !isValidUUID(fileId)) {
		throw new ApiError(401, 'AUTH_INVALID', 'Download authorization does not match this file');
	}

	// The cookie says who may download; the chest decides whether it still may (expiry, revocation)
	const manifest = await getChest(env.R2_STORAGE, claims.code, getCurrentTimestamp());
	const file = manifest?.sessionId === claims.sessionId ? manifest.files.find((candidate) => candidate.fileId === fileId) : undefined;
	if (!file) {
		throw new ApiError(404, 'FILE_NOT_FOUND', 'File not found or chest expired');
	}

	const r2Object = await env.R2_STORAGE.get(fileKey(claims.sessionId, fileId));
	if (!r2Object) {
		throw new ApiError(404, 'FILE_NOT_FOUND', 'File not found in storage');
	}

	// The name comes from the chest manifest, never from the request
	return new Response(r2Object.body, {
		status: 200,
		headers: {
			'Content-Type': file.mimeType,
			'Content-Disposition': contentDisposition(file.filename),
			'Content-Length': String(r2Object.size),
			'Cache-Control': 'no-store',
			'X-Content-Type-Options': 'nosniff',
			'Referrer-Policy': 'no-referrer',
		},
	});
}

// POST /api/upload-sessions/:sessionId/multipart/create - Create multipart upload
async function handleCreateMultipartUpload(request: Request, env: Env, sessionId: string): Promise<Response> {
	await enforceRateLimit(env.UPLOAD_LIMITER, request, 'multipart-create');
	await authorizeUpload(request, env, sessionId);
	const { filename, mimeType, fileSize } = await readJson<CreateMultipartUploadRequest>(request);

	if (!filename || !mimeType || !fileSize || fileSize <= 0 || !Number.isInteger(fileSize)) {
		throw new ApiError(400, 'INVALID_REQUEST', 'Invalid multipart upload parameters');
	}
	checkFilename(filename);
	if (fileSize > LIMITS.maxMultipartFileBytes) {
		throw new ApiError(413, 'FILE_TOO_LARGE', 'File is larger than the limit');
	}

	const fileId = generateUUID();
	const multipartUpload = await env.R2_STORAGE.createMultipartUpload(
		fileKey(sessionId, fileId),
		fileUploadOptions({ filename, mimeType, isText: false }),
	);

	// Record the upload before handing out its token; if the session cannot take it (state or quota), drop the R2 upload
	try {
		await registerMultipartUpload(env.R2_STORAGE, sessionId, {
			fileId,
			uploadId: multipartUpload.uploadId,
			state: 'ACTIVE',
			createdAt: getCurrentTimestamp(),
			size: fileSize,
		});
	} catch (error) {
		await multipartUpload.abort().catch(() => undefined);
		throw error;
	}

	const response: CreateMultipartUploadResponse = {
		fileId,
		// The raw R2 uploadId stays server-side inside a signed token
		uploadId: await createMultipartJWT(sessionId, fileId, multipartUpload.uploadId, filename, mimeType, fileSize, env.JWT_SECRET),
	};
	return json(response);
}

// Runs `action` while holding a write lease on the session, for a multipart upload that must still be ACTIVE
async function withActiveMultipart<T>(
	env: Env,
	sessionId: string,
	fileId: string,
	uploadId: string,
	action: (entry: MultipartUploadEntry) => Promise<T>,
	onSuccess?: (result: T) => { files: ChestFile[]; closeState: 'COMPLETED' | 'ABORTED' },
	// For idempotent requests: if the upload is already in this state, return this value instead of acting
	alreadyInState?: { state: 'ABORTED'; result: T },
): Promise<T> {
	const leaseId = generateUUID();
	const record = await acquireLease(env.R2_STORAGE, sessionId, {
		id: leaseId,
		expiresAt: getCurrentTimestamp() + UPLOAD_LEASE_SECONDS,
		files: 0,
		bytes: 0,
	});
	const entry = record.multipartUploads.find((candidate) => candidate.fileId === fileId);

	try {
		if (!entry) {
			throw new ApiError(404, 'UPLOAD_NOT_FOUND', 'Multipart upload not found');
		}
		if (entry.uploadId !== uploadId) {
			throw new ApiError(403, 'TOKEN_MISMATCH', 'Token does not match upload session');
		}
		if (alreadyInState && entry.state === alreadyInState.state) {
			await releaseLease(env.R2_STORAGE, sessionId, leaseId, []);
			return alreadyInState.result;
		}
		if (entry.state !== 'ACTIVE') {
			throw new ApiError(409, 'MULTIPART_CLOSED', 'This multipart upload was already completed or aborted');
		}

		const result = await action(entry);
		const outcome = onSuccess?.(result);
		await releaseLease(
			env.R2_STORAGE,
			sessionId,
			leaseId,
			outcome?.files ?? [],
			undefined,
			outcome && { fileId, state: outcome.closeState },
		);
		return result;
	} catch (error) {
		await releaseLease(env.R2_STORAGE, sessionId, leaseId, []).catch(() => undefined);
		throw error;
	}
}

// PUT /api/upload-sessions/:sessionId/multipart/:fileId/parts/:partNumber - Upload part
async function handleUploadPart(request: Request, env: Env, sessionId: string, fileId: string, partNumber: number): Promise<Response> {
	const payload = await authorizeMultipart(request, env, sessionId, fileId);
	await enforceRateLimit(env.PART_LIMITER, request, `part:${fileId}`);

	if (!(partNumber >= 1 && partNumber <= LIMITS.maxPartsPerUpload)) {
		throw new ApiError(400, 'INVALID_REQUEST', 'Invalid part number');
	}
	declaredLength(request, LIMITS.maxPartBytes);

	const body = await request.arrayBuffer();
	if (body.byteLength === 0) {
		throw new ApiError(400, 'INVALID_REQUEST', 'Empty part body');
	}
	if (body.byteLength > LIMITS.maxPartBytes) {
		throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Part is larger than the limit');
	}

	const uploadedPart = await withActiveMultipart(env, sessionId, fileId, payload.uploadId, async () => {
		const multipartUpload = env.R2_STORAGE.resumeMultipartUpload(fileKey(sessionId, fileId), payload.uploadId);
		return multipartUpload.uploadPart(partNumber, body);
	});

	const response: UploadPartResponse = {
		etag: uploadedPart.etag,
		partNumber,
	};
	return json(response);
}

// Validates the part list before it reaches R2
function validateParts(parts: unknown): { partNumber: number; etag: string }[] {
	if (!Array.isArray(parts) || parts.length === 0 || parts.length > LIMITS.maxPartsPerUpload) {
		throw new ApiError(400, 'INVALID_REQUEST', 'Invalid parts array');
	}
	const seen = new Set<number>();
	for (const part of parts) {
		const { partNumber, etag } = part as { partNumber?: unknown; etag?: unknown };
		if (!Number.isInteger(partNumber) || (partNumber as number) < 1 || (partNumber as number) > LIMITS.maxPartsPerUpload) {
			throw new ApiError(400, 'INVALID_REQUEST', 'Invalid part number');
		}
		if (typeof etag !== 'string' || etag.length === 0 || etag.length > 256) {
			throw new ApiError(400, 'INVALID_REQUEST', 'Invalid part etag');
		}
		if (seen.has(partNumber as number)) {
			throw new ApiError(400, 'INVALID_REQUEST', 'Duplicate part number');
		}
		seen.add(partNumber as number);
	}
	return (parts as { partNumber: number; etag: string }[])
		.map(({ partNumber, etag }) => ({ partNumber, etag }))
		.sort((a, b) => a.partNumber - b.partNumber);
}

// POST /api/upload-sessions/:sessionId/multipart/:fileId/complete - Complete multipart upload
async function handleCompleteMultipartUpload(request: Request, env: Env, sessionId: string, fileId: string): Promise<Response> {
	const payload = await authorizeMultipart(request, env, sessionId, fileId);
	const { parts } = await readJson<CompleteMultipartUploadRequest>(request);
	const sortedParts = validateParts(parts);

	const registered = await withActiveMultipart(
		env,
		sessionId,
		fileId,
		payload.uploadId,
		async () => {
			const multipartUpload = env.R2_STORAGE.resumeMultipartUpload(fileKey(sessionId, fileId), payload.uploadId);
			await multipartUpload.complete(sortedParts);
			try {
				return await verifyStoredFile(env.R2_STORAGE, sessionId, fileId, {
					size: payload.fileSize,
					filename: payload.filename,
					mimeType: payload.mimeType,
					isText: false,
				});
			} catch (error) {
				if (error instanceof StorageVerificationError && error.reason === 'size-mismatch') {
					// The declared size does not match what was uploaded; remove the object instead of storing it
					await env.R2_STORAGE.delete(fileKey(sessionId, fileId)).catch(() => undefined);
					throw new ApiError(400, 'SIZE_MISMATCH', 'Uploaded size does not match the declared file size');
				}
				throw error;
			}
		},
		(file) => ({ files: [file], closeState: 'COMPLETED' }),
	);

	const response: CompleteMultipartUploadResponse = {
		fileId,
		filename: registered.filename,
	};
	return json(response);
}

// POST /api/upload-sessions/:sessionId/multipart/:fileId/abort - Abort an unfinished multipart upload
async function handleAbortMultipartUpload(request: Request, env: Env, sessionId: string, fileId: string): Promise<Response> {
	const payload = await authorizeMultipart(request, env, sessionId, fileId);

	// Aborting twice is harmless: the first abort already closed the upload
	const outcome = await withActiveMultipart(
		env,
		sessionId,
		fileId,
		payload.uploadId,
		async () => {
			await env.R2_STORAGE.resumeMultipartUpload(fileKey(sessionId, fileId), payload.uploadId).abort();
			return true;
		},
		() => ({ files: [], closeState: 'ABORTED' }),
		{ state: 'ABORTED', result: true },
	);
	return json({ fileId, aborted: outcome });
}
