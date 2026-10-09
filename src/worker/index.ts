import { SessionError } from './session';
import {
	Env,
	CreateChestRequest,
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
	ChestManifest,
	UploadJWTPayload,
	MultipartJWTPayload,
} from './types';
import {
	generateUUID,
	createUploadJWT,
	createChestJWT,
	verifyUploadJWT,
	verifyChestJWT,
	createMultipartJWT,
	verifyMultipartJWT,
	isValidUUID,
	isValidRetrievalCode,
	calculateExpiry,
	getCurrentTimestamp,
	verifyAnyTOTP,
	isValidValidityDays,
	contentDisposition,
} from './utils';
import { cleanupExpired, createChest, fileKey, fileUploadOptions, getChest, getSessionFiles, isSessionOpen, openSession } from './storage';

// Error responses: { "error": human-readable message, "code": stable machine-readable code }
class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

function errorResponse(error: ApiError): Response {
	return json({ error: error.message, code: error.code }, error.status);
}

export default {
	async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		// Static assets normally never reach the Worker (run_worker_first only covers /api/*)
		if (path !== '/api' && !path.startsWith('/api/')) {
			return env.ASSETS.fetch(request);
		}

		const segments = path.split('/');
		const method = request.method;

		try {
			if (path === '/api/config' && method === 'GET') {
				return handleGetConfig(env);
			}

			if (path === '/api/chest' && method === 'POST') {
				return await handleCreateChest(request, env);
			}

			if (path.match(/^\/api\/chest\/[^\/]+\/upload$/) && method === 'POST') {
				return await handleUploadFiles(request, env, segments[3]);
			}

			if (path.match(/^\/api\/chest\/[^\/]+\/multipart\/create$/) && method === 'POST') {
				return await handleCreateMultipartUpload(request, env, segments[3]);
			}

			if (path.match(/^\/api\/chest\/[^\/]+\/multipart\/[^\/]+\/part\/[^\/]+$/) && method === 'PUT') {
				return await handleUploadPart(request, env, segments[3], segments[5], parseInt(segments[7]));
			}

			if (path.match(/^\/api\/chest\/[^\/]+\/multipart\/[^\/]+\/complete$/) && method === 'POST') {
				return await handleCompleteMultipartUpload(request, env, segments[3], segments[5]);
			}

			if (path.match(/^\/api\/chest\/[^\/]+\/complete$/) && method === 'POST') {
				return await handleCompleteUpload(request, env, segments[3]);
			}

			if (path.match(/^\/api\/retrieve\/[^\/]+$/) && method === 'GET') {
				return await handleRetrieveChest(env, segments[3]);
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
				if (error.code === 'NOT_FOUND')
					return errorResponse(new ApiError(404, 'SESSION_NOT_FOUND', 'Session not found or already completed'));
				if (error.code === 'CORRUPT_RECORD') console.error('Corrupt session record');
				if (error.code !== 'CORRUPT_RECORD') return errorResponse(new ApiError(409, 'CONFLICT', 'Session state changed, try again'));
			}
			console.error('Error:', error);
			return errorResponse(new ApiError(500, 'INTERNAL_ERROR', 'Internal Server Error'));
		}
	},

	// Scheduled event handler (cron job)
	async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
		console.log('🧹 Starting scheduled cleanup job at', new Date().toISOString());

		try {
			const result = await cleanupExpired(env.R2_STORAGE, getCurrentTimestamp());
			console.log('✅ Cleanup completed:', result);
		} catch (error) {
			console.error('❌ Cleanup job failed:', error);
			// Don't throw - we don't want to fail the cron job
		}
	},
} satisfies ExportedHandler<Env>;

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

// GET /api/config - Get server configuration
function handleGetConfig(env: Env): Response {
	return json({ requireTOTP: env.REQUIRE_TOTP === 'true' });
}

// POST /api/chest - Create new chest
async function handleCreateChest(request: Request, env: Env): Promise<Response> {
	if (env.REQUIRE_TOTP === 'true') {
		const requestBody = await readJson<CreateChestRequest>(request);

		if (!requestBody.totpToken) {
			throw new ApiError(401, 'TOTP_REQUIRED', 'TOTP token required');
		}

		if (!env.TOTP_SECRETS) {
			throw new ApiError(500, 'TOTP_NOT_CONFIGURED', 'TOTP not configured on server');
		}

		if (!(await verifyAnyTOTP(requestBody.totpToken, env.TOTP_SECRETS))) {
			throw new ApiError(401, 'TOTP_INVALID', 'Invalid TOTP token');
		}
	}

	const sessionId = generateUUID();
	const createdAt = getCurrentTimestamp();
	const uploadToken = await createUploadJWT(sessionId, env.JWT_SECRET, createdAt);
	await openSession(env.R2_STORAGE, sessionId, createdAt);

	const response: CreateChestResponse = {
		sessionId,
		uploadToken,
		expiresIn: 86400, // 24 hours
	};
	return json(response);
}

// POST /api/chest/:sessionId/upload - Upload files
async function handleUploadFiles(request: Request, env: Env, sessionId: string): Promise<Response> {
	await authorizeUpload(request, env, sessionId);

	const formData = await request.formData();
	const uploadedFiles: UploadFileResponse['uploadedFiles'] = [];
	const r2Operations: Promise<R2Object | null>[] = [];

	for (const value of formData.getAll('files')) {
		if (value instanceof File) {
			const fileId = generateUUID();
			const filename = value.name || 'unnamed-file';
			const options = fileUploadOptions({ filename, mimeType: value.type || 'application/octet-stream', isText: false });
			r2Operations.push(env.R2_STORAGE.put(fileKey(sessionId, fileId), value.stream(), options));
			uploadedFiles.push({ fileId, filename, isText: false });
		}
	}

	for (const textItem of formData.getAll('textItems')) {
		if (typeof textItem === 'string') {
			let textData: { content?: unknown; filename?: unknown };
			try {
				textData = JSON.parse(textItem);
			} catch {
				throw new ApiError(400, 'INVALID_REQUEST', 'Invalid text item');
			}
			if (typeof textData.content !== 'string') {
				throw new ApiError(400, 'INVALID_REQUEST', 'Invalid text item');
			}

			const fileId = generateUUID();
			const filename = typeof textData.filename === 'string' && textData.filename ? textData.filename : `text-${Date.now()}.txt`;
			const options = fileUploadOptions({ filename, mimeType: 'text/plain', isText: true });
			r2Operations.push(env.R2_STORAGE.put(fileKey(sessionId, fileId), textData.content, options));
			uploadedFiles.push({ fileId, filename, isText: true });
		}
	}

	await Promise.all(r2Operations);

	const response: UploadFileResponse = { uploadedFiles };
	return json(response);
}

// POST /api/chest/:sessionId/complete - Complete upload and generate retrieval code
async function handleCompleteUpload(request: Request, env: Env, sessionId: string): Promise<Response> {
	const payload = await authorizeUpload(request, env, sessionId);
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

	const files = await getSessionFiles(env.R2_STORAGE, sessionId, fileIds);
	if (!files) {
		throw new ApiError(400, 'FILE_NOT_IN_SESSION', 'Some files do not belong to this session');
	}

	const manifest: ChestManifest = {
		version: 1,
		sessionId,
		createdAt: payload.iat,
		expiresAt: calculateExpiry(validityDays),
		files,
	};

	const retrievalCode = await createChest(env.R2_STORAGE, manifest);
	if (!retrievalCode) {
		throw new ApiError(500, 'CODE_GENERATION_FAILED', 'Failed to generate unique retrieval code');
	}

	const response: CompleteUploadResponse = {
		retrievalCode,
		expiryDate: manifest.expiresAt ? new Date(manifest.expiresAt * 1000).toISOString() : null,
	};
	return json(response);
}

// GET /api/retrieve/:retrievalCode - Get chest contents
async function handleRetrieveChest(env: Env, retrievalCode: string): Promise<Response> {
	if (!isValidRetrievalCode(retrievalCode)) {
		throw new ApiError(400, 'INVALID_CODE', 'Invalid retrieval code format');
	}

	const manifest = await getChest(env.R2_STORAGE, retrievalCode, getCurrentTimestamp());
	if (!manifest) {
		throw new ApiError(404, 'CHEST_NOT_FOUND', 'Retrieval code not found or expired');
	}

	const response: RetrieveChestResponse = {
		files: manifest.files,
		chestToken: await createChestJWT(manifest.sessionId, retrievalCode, manifest.expiresAt, env.JWT_SECRET),
		expiryDate: manifest.expiresAt ? new Date(manifest.expiresAt * 1000).toISOString() : null,
	};
	return json(response);
}

// GET /api/download/:fileId - Download file
async function handleDownloadFile(request: Request, env: Env, fileId: string): Promise<Response> {
	// Token from header, or from the query string for direct browser downloads
	const url = new URL(request.url);
	const tokenFromQuery = url.searchParams.get('token');
	const token = request.headers.has('Authorization') || !tokenFromQuery ? bearerToken(request) : tokenFromQuery;

	let payload;
	try {
		payload = await verifyChestJWT(token, env.JWT_SECRET);
	} catch {
		throw new ApiError(401, 'AUTH_INVALID', 'Invalid token');
	}

	if (!isValidUUID(fileId)) {
		throw new ApiError(400, 'INVALID_REQUEST', 'Invalid file ID format');
	}

	// The manifest decides which files belong to the chest and whether it is still valid
	const manifest = await getChest(env.R2_STORAGE, payload.code, getCurrentTimestamp());
	const file = manifest?.sessionId === payload.sessionId ? manifest.files.find((f) => f.fileId === fileId) : undefined;
	if (!file) {
		throw new ApiError(404, 'FILE_NOT_FOUND', 'File not found or session expired');
	}

	const r2Object = await env.R2_STORAGE.get(fileKey(payload.sessionId, fileId));
	if (!r2Object) {
		throw new ApiError(404, 'FILE_NOT_FOUND', 'File not found in storage');
	}

	return new Response(r2Object.body, {
		status: 200,
		headers: {
			'Content-Type': file.mimeType,
			'Content-Disposition': contentDisposition(url.searchParams.get('filename') || file.filename),
			'Content-Length': String(r2Object.size),
		},
	});
}

// POST /api/chest/:sessionId/multipart/create - Create multipart upload
async function handleCreateMultipartUpload(request: Request, env: Env, sessionId: string): Promise<Response> {
	await authorizeUpload(request, env, sessionId);
	const { filename, mimeType, fileSize } = await readJson<CreateMultipartUploadRequest>(request);

	if (!filename || !mimeType || !fileSize || fileSize <= 0) {
		throw new ApiError(400, 'INVALID_REQUEST', 'Invalid multipart upload parameters');
	}

	const fileId = generateUUID();
	const multipartUpload = await env.R2_STORAGE.createMultipartUpload(
		fileKey(sessionId, fileId),
		fileUploadOptions({ filename, mimeType, isText: false }),
	);

	const response: CreateMultipartUploadResponse = {
		fileId,
		// The raw R2 uploadId stays server-side inside a signed token
		uploadId: await createMultipartJWT(sessionId, fileId, multipartUpload.uploadId, filename, mimeType, fileSize, env.JWT_SECRET),
	};
	return json(response);
}

// PUT /api/chest/:sessionId/multipart/:fileId/part/:partNumber - Upload part
async function handleUploadPart(request: Request, env: Env, sessionId: string, fileId: string, partNumber: number): Promise<Response> {
	const payload = await authorizeMultipart(request, env, sessionId, fileId);

	if (!(partNumber >= 1 && partNumber <= 10000)) {
		throw new ApiError(400, 'INVALID_REQUEST', 'Invalid part number');
	}

	const body = await request.arrayBuffer();
	if (body.byteLength === 0) {
		throw new ApiError(400, 'INVALID_REQUEST', 'Empty part body');
	}

	const multipartUpload = env.R2_STORAGE.resumeMultipartUpload(fileKey(sessionId, fileId), payload.uploadId);
	const uploadedPart = await multipartUpload.uploadPart(partNumber, body);

	const response: UploadPartResponse = {
		etag: uploadedPart.etag,
		partNumber,
	};
	return json(response);
}

// POST /api/chest/:sessionId/multipart/:fileId/complete - Complete multipart upload
async function handleCompleteMultipartUpload(request: Request, env: Env, sessionId: string, fileId: string): Promise<Response> {
	const payload = await authorizeMultipart(request, env, sessionId, fileId);
	const { parts } = await readJson<CompleteMultipartUploadRequest>(request);

	if (!Array.isArray(parts) || parts.length === 0) {
		throw new ApiError(400, 'INVALID_REQUEST', 'Invalid parts array');
	}

	const sortedParts = [...parts].sort((a, b) => a.partNumber - b.partNumber);
	const multipartUpload = env.R2_STORAGE.resumeMultipartUpload(fileKey(sessionId, fileId), payload.uploadId);
	await multipartUpload.complete(sortedParts);

	const response: CompleteMultipartUploadResponse = {
		fileId,
		filename: payload.filename,
	};
	return json(response);
}
