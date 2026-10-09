// Chest manifest stored in R2 at codes/{CODE}
export interface ChestFile {
	fileId: string;
	filename: string;
	size: number;
	mimeType: string;
	isText: boolean;
	fileExtension: string | null;
}

export interface ChestManifest {
	version: 1;
	sessionId: string;
	// Upload session start (upload JWT iat); locates the session's pending marker
	createdAt: number;
	expiresAt: number | null;
	files: ChestFile[];
}

// API Request/Response types
export interface CreateChestResponse {
	sessionId: string;
	uploadToken: string;
	expiresIn: number;
}

export interface UploadFileResponse {
	uploadedFiles: Array<{
		fileId: string;
		filename: string;
		isText: boolean;
	}>;
}

// Multipart upload types
export interface CreateMultipartUploadRequest {
	filename: string;
	mimeType: string;
	fileSize: number;
}

export interface CreateMultipartUploadResponse {
	fileId: string;
	uploadId: string;
}

export interface UploadPartResponse {
	etag: string;
	partNumber: number;
}

export interface CompleteMultipartUploadRequest {
	parts: Array<{
		partNumber: number;
		etag: string;
	}>;
}

export interface CompleteMultipartUploadResponse {
	fileId: string;
	filename: string;
}

export interface CompleteUploadRequest {
	fileIds: string[];
	validityDays: number; // 1, 3, 7, 15, or -1 for permanent
}

export interface CompleteUploadResponse {
	retrievalCode: string;
	expiryDate: string | null;
}

export interface RetrieveChestResponse {
	files: ChestFile[];
	chestToken: string;
	expiryDate: string | null;
}

// JWT Payload types
export interface UploadJWTPayload {
	sessionId: string;
	type: 'upload';
	iat: number;
	exp: number;
}

export interface ChestJWTPayload {
	sessionId: string;
	code: string;
	type: 'chest';
	iat: number;
	exp: number;
}

export interface DownloadJWTPayload {
	sessionId: string;
	code: string;
	fileId: string;
	type: 'download';
	iat: number;
	exp: number;
}

export interface MultipartJWTPayload {
	sessionId: string;
	fileId: string;
	uploadId: string;
	filename: string;
	mimeType: string;
	fileSize: number;
	type: 'multipart';
	iat: number;
	exp: number;
}

// Cloudflare rate limiting binding (ratelimits in wrangler.jsonc)
export interface RateLimitBinding {
	limit(options: { key: string }): Promise<{ success: boolean }>;
}

// Cloudflare Env type
export interface Env {
	AUTH_LIMITER?: RateLimitBinding;
	RETRIEVE_LIMITER?: RateLimitBinding;
	UPLOAD_LIMITER?: RateLimitBinding;
	PART_LIMITER?: RateLimitBinding;
	PART_TOTAL_LIMITER?: RateLimitBinding;
	// Initial setup (see auth/bootstrap.ts). BOOTSTRAP_ENABLED is a plain var; the password is a secret.
	BOOTSTRAP_ENABLED?: string;
	ADMIN_BOOTSTRAP_PASSWORD?: string;
	// 32-byte AES-GCM key (base64) that encrypts the TOTP seed
	AUTH_ENCRYPTION_KEY?: string;
	ASSETS: Fetcher;
	R2_STORAGE: R2Bucket;
	JWT_SECRET: string;
	// Optional: the one hostname passkeys are bound to (for example pocket.example.com)
	PASSKEY_RP_ID?: string;
}
