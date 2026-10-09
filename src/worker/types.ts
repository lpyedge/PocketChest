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
export interface CreateChestRequest {
	totpToken?: string;
}

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

export interface UploadPartRequest {
	partNumber: number;
	data: ArrayBuffer;
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

// Cloudflare Env type
export interface Env {
	ASSETS: Fetcher;
	R2_STORAGE: R2Bucket;
	JWT_SECRET: string;
	TOTP_SECRETS?: string; // Format: "name1:secret1,name2:secret2"
	REQUIRE_TOTP?: string; // "true" to require TOTP authentication
}
