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
	generateRetrievalCode,
	calculateExpiry,
	getCurrentTimestamp,
	verifyAnyTOTP,
	isValidValidityDays,
	contentDisposition,
} from './utils';

export default {
	async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		// Static assets normally never reach the Worker (run_worker_first only covers /api/*)
		if (path !== '/api' && !path.startsWith('/api/')) {
			return env.ASSETS.fetch(request);
		}

		try {
			// Route handling
			if (path === '/api/config' && request.method === 'GET') {
				return await handleGetConfig(env);
			}

			if (path === '/api/chest' && request.method === 'POST') {
				return await handleCreateChest(request, env);
			}

			if (path.match(/^\/api\/chest\/[^\/]+\/upload$/) && request.method === 'POST') {
				const sessionId = path.split('/')[3];
				return await handleUploadFiles(request, env, sessionId);
			}

			// Multipart upload routes
			if (path.match(/^\/api\/chest\/[^\/]+\/multipart\/create$/) && request.method === 'POST') {
				const sessionId = path.split('/')[3];
				return await handleCreateMultipartUpload(request, env, sessionId);
			}

			if (path.match(/^\/api\/chest\/[^\/]+\/multipart\/[^\/]+\/part\/[^\/]+$/) && request.method === 'PUT') {
				const sessionId = path.split('/')[3];
				const fileId = path.split('/')[5];
				const partNumber = parseInt(path.split('/')[7]);
				return await handleUploadPart(request, env, sessionId, fileId, partNumber);
			}

			if (path.match(/^\/api\/chest\/[^\/]+\/multipart\/[^\/]+\/complete$/) && request.method === 'POST') {
				const sessionId = path.split('/')[3];
				const fileId = path.split('/')[5];
				return await handleCompleteMultipartUpload(request, env, sessionId, fileId);
			}

			if (path.match(/^\/api\/chest\/[^\/]+\/complete$/) && request.method === 'POST') {
				const sessionId = path.split('/')[3];
				return await handleCompleteUpload(request, env, sessionId);
			}

			if (path.match(/^\/api\/retrieve\/[^\/]+$/) && request.method === 'GET') {
				const retrievalCode = path.split('/')[3];
				return await handleRetrieveChest(env, retrievalCode);
			}

			if (path.match(/^\/api\/download\/[^\/]+$/) && request.method === 'GET') {
				const fileId = path.split('/')[3];
				return await handleDownloadFile(request, env, fileId);
			}

			return new Response('Not Found', { status: 404 });
		} catch (error) {
			console.error('Error:', error);
			return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			});
		}
	},

	// Scheduled event handler (cron job)
	async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
		console.log('🧹 Starting scheduled cleanup job at', new Date().toISOString());

		try {
			const result = await cleanupExpiredContent(env);
			console.log('✅ Cleanup completed successfully:', result);
		} catch (error) {
			console.error('❌ Cleanup job failed:', error);
			// Don't throw - we don't want to fail the cron job
		}
	},
} satisfies ExportedHandler<Env>;

// GET /api/config - Get server configuration
async function handleGetConfig(env: Env): Promise<Response> {
	const config = {
		requireTOTP: env.REQUIRE_TOTP === 'true',
	};

	return new Response(JSON.stringify(config), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}

// POST /api/chest - Create new chest
async function handleCreateChest(request: Request, env: Env): Promise<Response> {
	// Check if TOTP is required
	const requireTOTP = env.REQUIRE_TOTP === 'true';

	if (requireTOTP) {
		// Parse request body for TOTP token
		let requestBody: CreateChestRequest;
		try {
			requestBody = await request.json();
		} catch {
			return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		// Validate TOTP token
		if (!requestBody.totpToken) {
			return new Response(JSON.stringify({ error: 'TOTP token required' }), {
				status: 401,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		if (!env.TOTP_SECRETS) {
			return new Response(JSON.stringify({ error: 'TOTP not configured on server' }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' },
			});
		}

		const isValidTOTP = await verifyAnyTOTP(requestBody.totpToken, env.TOTP_SECRETS);
		if (!isValidTOTP) {
			return new Response(JSON.stringify({ error: 'Invalid TOTP token' }), {
				status: 401,
				headers: { 'Content-Type': 'application/json' },
			});
		}
	}

	// Generate session ID
	const sessionId = generateUUID();

	// Create upload JWT
	const uploadToken = await createUploadJWT(sessionId, env.JWT_SECRET);

	// Insert session into database
	await env.DB.prepare(
		`
		INSERT INTO sessions (session_id, created_at, updated_at)
		VALUES (?, ?, ?)
	`,
	)
		.bind(sessionId, getCurrentTimestamp(), getCurrentTimestamp())
		.run();

	const response: CreateChestResponse = {
		sessionId,
		uploadToken,
		expiresIn: 86400, // 24 hours
	};

	return new Response(JSON.stringify(response), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}

// POST /api/chest/:sessionId/upload - Upload files
async function handleUploadFiles(request: Request, env: Env, sessionId: string): Promise<Response> {
	// Verify JWT token
	const authHeader = request.headers.get('Authorization');
	if (!authHeader || !authHeader.startsWith('Bearer ')) {
		return new Response('Unauthorized', { status: 401 });
	}

	const token = authHeader.substring(7);
	let payload;
	try {
		payload = await verifyUploadJWT(token, env.JWT_SECRET);
	} catch (_error) {
		return new Response('Invalid token', { status: 401 });
	}

	// Validate sessionId matches JWT and URL param
	if (payload.sessionId !== sessionId || !isValidUUID(sessionId)) {
		return new Response('Invalid session', { status: 400 });
	}

	// Check session exists and is not completed
	const session = await env.DB.prepare(
		`
		SELECT * FROM sessions WHERE session_id = ? AND upload_complete = FALSE
	`,
	)
		.bind(sessionId)
		.first();

	if (!session) {
		return new Response('Session not found or already completed', { status: 404 });
	}

	// Parse multipart form data
	const formData = await request.formData();
	const uploadedFiles: Array<{ fileId: string; filename: string; isText: boolean }> = [];
	const fileInserts: any[] = [];
	const r2Operations: Promise<any>[] = [];
	const timestamp = getCurrentTimestamp();

	// Collect all file operations without executing database queries yet
	for (const [key, value] of formData.entries()) {
		if (key === 'files' && value instanceof File) {
			const fileId = generateUUID();
			const filename = value.name || 'unnamed-file';
			const mimeType = value.type || 'application/octet-stream';
			const fileSize = value.size;

			// Queue R2 operation
			r2Operations.push(env.R2_STORAGE.put(`${sessionId}/${fileId}`, value.stream()));

			// Queue database operation
			fileInserts.push(
				env.DB.prepare(
					`
					INSERT INTO files (file_id, session_id, original_filename, mime_type, file_size, file_extension, is_text, created_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				`,
				).bind(fileId, sessionId, filename, mimeType, fileSize, getFileExtension(filename), false, timestamp),
			);

			uploadedFiles.push({ fileId, filename, isText: false });
		}
	}

	// Handle text items
	const textItems = formData.getAll('textItems');
	for (const textItem of textItems) {
		if (typeof textItem === 'string') {
			const textData = JSON.parse(textItem);
			const fileId = generateUUID();
			const filename = textData.filename || `text-${Date.now()}.txt`;
			const content = textData.content;
			const mimeType = 'text/plain';
			const fileSize = new TextEncoder().encode(content).length;

			// Queue R2 operation
			r2Operations.push(env.R2_STORAGE.put(`${sessionId}/${fileId}`, content));

			// Queue database operation
			fileInserts.push(
				env.DB.prepare(
					`
					INSERT INTO files (file_id, session_id, original_filename, mime_type, file_size, file_extension, is_text, created_at)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				`,
				).bind(fileId, sessionId, filename, mimeType, fileSize, getFileExtension(filename), true, timestamp),
			);

			uploadedFiles.push({ fileId, filename, isText: true });
		}
	}

	// Execute all operations in parallel: R2 storage + database batch
	const [_r2Results, dbResult] = await Promise.all([
		Promise.all(r2Operations),
		fileInserts.length > 0 ? env.DB.batch(fileInserts) : Promise.resolve([]),
	]);

	// Verify all database operations succeeded
	if (fileInserts.length > 0) {
		const failedInserts = dbResult.filter((result) => !result.success);
		if (failedInserts.length > 0) {
			throw new Error(`Failed to insert ${failedInserts.length} file records`);
		}
	}

	const response: UploadFileResponse = { uploadedFiles };
	return new Response(JSON.stringify(response), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}

// POST /api/chest/:sessionId/complete - Complete upload and generate retrieval code
async function handleCompleteUpload(request: Request, env: Env, sessionId: string): Promise<Response> {
	// Verify JWT token
	const authHeader = request.headers.get('Authorization');
	if (!authHeader || !authHeader.startsWith('Bearer ')) {
		return new Response('Unauthorized', { status: 401 });
	}

	const token = authHeader.substring(7);
	let payload;
	try {
		payload = await verifyUploadJWT(token, env.JWT_SECRET);
	} catch (_error) {
		return new Response('Invalid token', { status: 401 });
	}

	if (payload.sessionId !== sessionId || !isValidUUID(sessionId)) {
		return new Response('Invalid session', { status: 400 });
	}

	// Parse request body
	const body: CompleteUploadRequest = await request.json();
	const { fileIds, validityDays } = body;

	// Validate fileIds and validity period
	if (!Array.isArray(fileIds) || fileIds.length === 0 || !fileIds.every((fileId) => typeof fileId === 'string' && isValidUUID(fileId))) {
		return new Response('Invalid file ID format', { status: 400 });
	}

	if (!isValidValidityDays(validityDays)) {
		return new Response('Invalid validity period', { status: 400 });
	}

	const expiryDate = calculateExpiry(validityDays);
	const timestamp = getCurrentTimestamp();

	// Validate file ownership
	const fileCheckResult = await env.DB.prepare(
		`
		SELECT COUNT(*) as count FROM files
		WHERE file_id IN (${fileIds.map(() => '?').join(',')}) AND session_id = ?
	`,
	)
		.bind(...fileIds, sessionId)
		.first<{ count: number }>();

	if (fileCheckResult?.count !== fileIds.length) {
		return new Response('Some files do not belong to this session', { status: 400 });
	}

	// Assign a retrieval code; the UNIQUE constraint rejects collisions, so retry with a fresh code
	let retrievalCode = '';
	let updateResult: D1Result | null = null;
	for (let attempt = 0; attempt < 5 && !updateResult; attempt++) {
		retrievalCode = generateRetrievalCode();
		try {
			updateResult = await env.DB.prepare(
				`
				UPDATE sessions
				SET retrieval_code = ?, upload_complete = TRUE, expiry_date = ?, updated_at = ?
				WHERE session_id = ? AND upload_complete = FALSE
			`,
			)
				.bind(retrievalCode, expiryDate, timestamp, sessionId)
				.run();
		} catch (error) {
			if (!String(error).includes('UNIQUE')) {
				throw error;
			}
		}
	}

	if (!updateResult) {
		return new Response('Failed to generate unique retrieval code', { status: 500 });
	}

	// Check if session update was successful
	if (updateResult.meta.changes === 0) {
		return new Response('Session not found or already completed', { status: 404 });
	}

	const response: CompleteUploadResponse = {
		retrievalCode,
		expiryDate: expiryDate ? new Date(expiryDate * 1000).toISOString() : null,
	};

	return new Response(JSON.stringify(response), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}

// GET /api/retrieve/:retrievalCode - Get chest contents
async function handleRetrieveChest(env: Env, retrievalCode: string): Promise<Response> {
	if (!isValidRetrievalCode(retrievalCode)) {
		return new Response('Invalid retrieval code format', { status: 400 });
	}

	// Find session by retrieval code
	const session = await env.DB.prepare(
		`
		SELECT * FROM sessions 
		WHERE retrieval_code = ? AND upload_complete = TRUE 
		AND (expiry_date IS NULL OR expiry_date > ?)
	`,
	)
		.bind(retrievalCode, getCurrentTimestamp())
		.first();

	if (!session) {
		return new Response('Retrieval code not found or expired', { status: 404 });
	}

	// Get all files for this session
	const files = await env.DB.prepare(
		`
		SELECT * FROM files WHERE session_id = ? ORDER BY created_at
	`,
	)
		.bind(session.session_id)
		.all();

	// Create chest JWT
	const chestToken = await createChestJWT(session.session_id as string, session.expiry_date as number | null, env.JWT_SECRET);

	const response: RetrieveChestResponse = {
		files: files.results.map((file) => ({
			fileId: file.file_id as string,
			filename: file.original_filename as string,
			size: file.file_size as number,
			mimeType: file.mime_type as string,
			isText: Boolean(file.is_text),
			fileExtension: file.file_extension as string | null,
		})),
		chestToken,
		expiryDate: session.expiry_date ? new Date((session.expiry_date as number) * 1000).toISOString() : null,
	};

	return new Response(JSON.stringify(response), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}

// GET /api/download/:fileId - Download file
async function handleDownloadFile(request: Request, env: Env, fileId: string): Promise<Response> {
	// Extract token from header or query parameter
	const url = new URL(request.url);
	const authHeader = request.headers.get('Authorization');
	const tokenFromQuery = url.searchParams.get('token');
	const filenameFromQuery = url.searchParams.get('filename');

	let token: string;
	if (authHeader && authHeader.startsWith('Bearer ')) {
		token = authHeader.substring(7);
	} else if (tokenFromQuery) {
		token = tokenFromQuery;
	} else {
		return new Response('Unauthorized', { status: 401 });
	}

	let payload;
	try {
		payload = await verifyChestJWT(token, env.JWT_SECRET);
	} catch (_error) {
		return new Response('Invalid token', { status: 401 });
	}

	if (!isValidUUID(fileId)) {
		return new Response('Invalid file ID format', { status: 400 });
	}

	// Get file metadata and verify session is still valid
	const fileWithSession = await env.DB.prepare(
		`
		SELECT f.*, s.expiry_date
		FROM files f
		JOIN sessions s ON f.session_id = s.session_id
		WHERE f.file_id = ? AND f.session_id = ?
		AND (s.expiry_date IS NULL OR s.expiry_date > ?)
	`,
	)
		.bind(fileId, payload.sessionId, getCurrentTimestamp())
		.first();

	if (!fileWithSession) {
		return new Response('File not found or session expired', { status: 404 });
	}

	// Get file from R2
	const r2Object = await env.R2_STORAGE.get(`${payload.sessionId}/${fileId}`);
	if (!r2Object) {
		return new Response('File not found in storage', { status: 404 });
	}

	// Use filename from query parameter if provided, otherwise use original filename
	const downloadFilename = filenameFromQuery || (fileWithSession.original_filename as string);

	// Return file with proper headers
	return new Response(r2Object.body, {
		status: 200,
		headers: {
			'Content-Type': fileWithSession.mime_type as string,
			'Content-Disposition': contentDisposition(downloadFilename),
			'Content-Length': String(fileWithSession.file_size),
		},
	});
}

// Helper function to get file extension
function getFileExtension(filename: string): string | null {
	const lastDot = filename.lastIndexOf('.');
	return lastDot > 0 ? filename.substring(lastDot + 1) : null;
}

// POST /api/chest/:sessionId/multipart/create - Create multipart upload
async function handleCreateMultipartUpload(request: Request, env: Env, sessionId: string): Promise<Response> {
	// Verify JWT token
	const authHeader = request.headers.get('Authorization');
	if (!authHeader || !authHeader.startsWith('Bearer ')) {
		return new Response('Unauthorized', { status: 401 });
	}

	const token = authHeader.substring(7);
	let payload;
	try {
		payload = await verifyUploadJWT(token, env.JWT_SECRET);
	} catch (_error) {
		return new Response('Invalid token', { status: 401 });
	}

	// Validate sessionId matches JWT and URL param
	if (payload.sessionId !== sessionId || !isValidUUID(sessionId)) {
		return new Response('Invalid session', { status: 400 });
	}

	// Check session exists and is not completed
	const session = await env.DB.prepare(
		`
		SELECT * FROM sessions WHERE session_id = ? AND upload_complete = FALSE
	`,
	)
		.bind(sessionId)
		.first();

	if (!session) {
		return new Response('Session not found or already completed', { status: 404 });
	}

	// Parse request body
	const body: CreateMultipartUploadRequest = await request.json();
	const { filename, mimeType, fileSize } = body;

	// Validate inputs
	if (!filename || !mimeType || !fileSize || fileSize <= 0) {
		return new Response('Invalid multipart upload parameters', { status: 400 });
	}

	const fileId = generateUUID();

	// Create multipart upload in R2
	const multipartUpload = await env.R2_STORAGE.createMultipartUpload(`${sessionId}/${fileId}`);

	// Create multipart JWT with 48-hour validity
	const multipartToken = await createMultipartJWT(
		sessionId,
		fileId,
		multipartUpload.uploadId,
		filename,
		mimeType,
		fileSize,
		env.JWT_SECRET,
	);

	const response: CreateMultipartUploadResponse = {
		fileId,
		uploadId: multipartToken, // Return JWT instead of raw uploadId
	};

	return new Response(JSON.stringify(response), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}

// PUT /api/chest/:sessionId/multipart/:fileId/part/:partNumber - Upload part
async function handleUploadPart(request: Request, env: Env, sessionId: string, fileId: string, partNumber: number): Promise<Response> {
	// Verify multipart JWT token from header
	const authHeader = request.headers.get('Authorization');
	if (!authHeader || !authHeader.startsWith('Bearer ')) {
		return new Response('Unauthorized', { status: 401 });
	}

	const token = authHeader.substring(7);
	let payload;
	try {
		payload = await verifyMultipartJWT(token, env.JWT_SECRET);
	} catch (_error) {
		return new Response('Invalid multipart token', { status: 401 });
	}

	// Validate sessionId and fileId match JWT and URL params
	if (payload.sessionId !== sessionId || payload.fileId !== fileId) {
		return new Response('Token does not match upload session', { status: 403 });
	}

	if (!isValidUUID(sessionId) || !isValidUUID(fileId)) {
		return new Response('Invalid session or file ID format', { status: 400 });
	}

	// Validate part number
	if (partNumber < 1 || partNumber > 10000) {
		return new Response('Invalid part number', { status: 400 });
	}

	// Get request body as ArrayBuffer
	const body = await request.arrayBuffer();
	if (!body || body.byteLength === 0) {
		return new Response('Empty part body', { status: 400 });
	}

	// Resume multipart upload using uploadId from JWT
	const multipartUpload = env.R2_STORAGE.resumeMultipartUpload(`${sessionId}/${fileId}`, payload.uploadId);
	const uploadedPart = await multipartUpload.uploadPart(partNumber, body);

	const response: UploadPartResponse = {
		etag: uploadedPart.etag,
		partNumber,
	};

	return new Response(JSON.stringify(response), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}

// POST /api/chest/:sessionId/multipart/:fileId/complete - Complete multipart upload
async function handleCompleteMultipartUpload(request: Request, env: Env, sessionId: string, fileId: string): Promise<Response> {
	// Verify multipart JWT token
	const authHeader = request.headers.get('Authorization');
	if (!authHeader || !authHeader.startsWith('Bearer ')) {
		return new Response('Unauthorized', { status: 401 });
	}

	const token = authHeader.substring(7);
	let payload;
	try {
		payload = await verifyMultipartJWT(token, env.JWT_SECRET);
	} catch (_error) {
		return new Response('Invalid multipart token', { status: 401 });
	}

	// Validate sessionId and fileId match JWT and URL params
	if (payload.sessionId !== sessionId || payload.fileId !== fileId) {
		return new Response('Token does not match upload session', { status: 403 });
	}

	if (!isValidUUID(sessionId) || !isValidUUID(fileId)) {
		return new Response('Invalid session or file ID format', { status: 400 });
	}

	// Parse request body
	const body: CompleteMultipartUploadRequest = await request.json();
	const { parts } = body;

	// Validate parts array
	if (!Array.isArray(parts) || parts.length === 0) {
		return new Response('Invalid parts array', { status: 400 });
	}

	// Sort parts by part number to ensure correct order
	const sortedParts = parts.sort((a, b) => a.partNumber - b.partNumber);

	// Resume multipart upload and complete it using uploadId from JWT
	const multipartUpload = env.R2_STORAGE.resumeMultipartUpload(`${sessionId}/${fileId}`, payload.uploadId);
	await multipartUpload.complete(sortedParts);

	// Now insert the file record into database (only after successful completion)
	const timestamp = getCurrentTimestamp();
	await env.DB.prepare(
		`
		INSERT INTO files (file_id, session_id, original_filename, mime_type, file_size, file_extension, is_text, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
	`,
	)
		.bind(fileId, sessionId, payload.filename, payload.mimeType, payload.fileSize, getFileExtension(payload.filename), false, timestamp)
		.run();

	const response: CompleteMultipartUploadResponse = {
		fileId,
		filename: payload.filename,
	};

	return new Response(JSON.stringify(response), {
		status: 200,
		headers: { 'Content-Type': 'application/json' },
	});
}

// Cleanup expired content (runs every hour via cron)
async function cleanupExpiredContent(env: Env): Promise<{
	expiredSessions: number;
	deletedFiles: number;
	r2ObjectsDeleted: number;
	incompleteSessions: number;
	errors: string[];
}> {
	const currentTimestamp = getCurrentTimestamp();
	const errors: string[] = [];
	let expiredSessions = 0;
	let deletedFiles = 0;
	let r2ObjectsDeleted = 0;
	let incompleteSessions = 0;

	console.log('🔍 Starting cleanup for timestamp:', currentTimestamp);

	try {
		// 1. Find expired sessions (permanent sessions have expiry_date = NULL, so they're excluded)
		const expiredSessionsResult = await env.DB.prepare(
			`
			SELECT session_id, retrieval_code FROM sessions 
			WHERE expiry_date IS NOT NULL AND expiry_date <= ?
		`,
		)
			.bind(currentTimestamp)
			.all();

		console.log(`📋 Found ${expiredSessionsResult.results.length} expired sessions`);

		// 2. Find incomplete sessions older than 48 hours (matching multipart JWT validity)
		const incompleteSessionsResult = await env.DB.prepare(
			`
			SELECT session_id FROM sessions 
			WHERE upload_complete = FALSE AND created_at <= ?
		`,
		)
			.bind(currentTimestamp - 48 * 60 * 60)
			.all();

		console.log(`📋 Found ${incompleteSessionsResult.results.length} incomplete sessions (>48h old)`);

		// Combine expired and incomplete sessions for cleanup
		const allSessionsToCleanup = [
			...expiredSessionsResult.results.map((s) => ({ session_id: s.session_id, reason: 'expired' })),
			...incompleteSessionsResult.results.map((s) => ({ session_id: s.session_id, reason: 'incomplete' })),
		];

		console.log(`🗑️  Total sessions to cleanup: ${allSessionsToCleanup.length}`);

		// Process each session
		for (const session of allSessionsToCleanup) {
			const sessionId = session.session_id as string;
			const reason = session.reason;

			try {
				// 3. Get file count for logging
				const filesResult = await env.DB.prepare(
					`
					SELECT COUNT(*) as count FROM files WHERE session_id = ?
				`,
				)
					.bind(sessionId)
					.first();

				const fileCount = (filesResult?.count as number) || 0;
				console.log(`📁 Session ${sessionId} (${reason}) has ${fileCount} files`);

				// 4. Delete ALL R2 objects for this session using prefix deletion
				try {
					const listResult = await env.R2_STORAGE.list({ prefix: `${sessionId}/` });

					if (listResult.objects.length > 0) {
						// Delete all objects with this session prefix
						const deletePromises = listResult.objects.map((obj) => env.R2_STORAGE.delete(obj.key));
						await Promise.all(deletePromises);
						r2ObjectsDeleted += listResult.objects.length;
						console.log(`🗑️ Deleted ${listResult.objects.length} R2 objects for session ${sessionId}`);
					}
				} catch (error) {
					errors.push(`Failed to delete R2 objects for session ${sessionId}: ${error}`);
				}

				// 5. Delete database records (files first due to foreign key constraint)
				await env.DB.prepare(`DELETE FROM files WHERE session_id = ?`).bind(sessionId).run();
				deletedFiles += fileCount;

				await env.DB.prepare(`DELETE FROM sessions WHERE session_id = ?`).bind(sessionId).run();

				if (reason === 'expired') {
					expiredSessions++;
				} else {
					incompleteSessions++;
				}

				console.log(`✅ Cleaned up session ${sessionId} (${reason}) with ${fileCount} files`);
			} catch (error) {
				errors.push(`Failed to cleanup session ${sessionId}: ${error}`);
				console.error(`❌ Error cleaning session ${sessionId}:`, error);
			}
		}

		console.log(
			`🧹 Cleanup summary: ${expiredSessions + incompleteSessions} sessions, ${deletedFiles} files, ${r2ObjectsDeleted} R2 objects`,
		);
	} catch (error) {
		errors.push(`Database query failed: ${error}`);
		console.error('❌ Database error during cleanup:', error);
	}

	return {
		expiredSessions,
		deletedFiles,
		r2ObjectsDeleted,
		incompleteSessions,
		errors,
	};
}
