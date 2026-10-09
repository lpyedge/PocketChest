import { UploadJWTPayload, ChestJWTPayload, MultipartJWTPayload, DownloadJWTPayload } from './types';

// Generate UUID v4
export function generateUUID(): string {
	return crypto.randomUUID();
}

// Generate 6-character alphanumeric retrieval code ("O" excluded to avoid confusion with "0")
export function generateRetrievalCode(): string {
	const chars = 'ABCDEFGHIJKLMNPQRSTUVWXYZ0123456789';
	// Reject bytes past the largest multiple of chars.length so every character is equally likely
	const limit = 256 - (256 % chars.length);
	let result = '';
	while (result.length < 6) {
		const bytes = crypto.getRandomValues(new Uint8Array(12));
		for (const byte of bytes) {
			if (byte < limit && result.length < 6) {
				result += chars[byte % chars.length];
			}
		}
	}
	return result;
}

// Helper function to safely encode UTF-8 strings to base64url
function base64UrlEncode(str: string): string {
	const encoder = new TextEncoder();
	const bytes = encoder.encode(str);
	const base64 = btoa(String.fromCharCode(...bytes));
	return base64.replace(/[=]/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// Helper function to safely decode base64url to UTF-8 strings
function base64UrlDecode(str: string): string {
	// Add padding if needed
	const padded = str.replace(/-/g, '+').replace(/_/g, '/');
	const padding = '='.repeat((4 - (padded.length % 4)) % 4);
	const base64 = padded + padding;

	const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
	const decoder = new TextDecoder();
	return decoder.decode(bytes);
}

// Simple JWT implementation for Cloudflare Workers
async function signJWT(payload: object, secret: string): Promise<string> {
	const header = {
		alg: 'HS256',
		typ: 'JWT',
	};

	const encoder = new TextEncoder();
	const headerB64 = base64UrlEncode(JSON.stringify(header));
	const payloadB64 = base64UrlEncode(JSON.stringify(payload));

	const message = `${headerB64}.${payloadB64}`;
	const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);

	const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
	const signatureB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
		.replace(/[=]/g, '')
		.replace(/\+/g, '-')
		.replace(/\//g, '_');

	return `${message}.${signatureB64}`;
}

async function verifyJWT(token: string, secret: string): Promise<any> {
	const parts = token.split('.');
	if (parts.length !== 3) {
		throw new Error('Invalid JWT format');
	}

	const [headerB64, payloadB64, signatureB64] = parts;

	// Verify signature
	const encoder = new TextEncoder();
	const message = `${headerB64}.${payloadB64}`;
	const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);

	const signature = Uint8Array.from(atob(signatureB64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
	const isValid = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(message));

	if (!isValid) {
		throw new Error('Invalid JWT signature');
	}

	// Decode payload
	const payload = JSON.parse(base64UrlDecode(payloadB64));

	// Check expiration
	if (payload.exp && Date.now() / 1000 > payload.exp) {
		throw new Error('JWT token expired');
	}

	return payload;
}

// Download cookies: one per file, valid for a minute, and bound to a single file of a single chest
export const DOWNLOAD_COOKIE_SECONDS = 60;

export async function createDownloadJWT(
	claims: { sessionId: string; code: string; fileId: string },
	secret: string,
	lifetimeSeconds: number = DOWNLOAD_COOKIE_SECONDS,
	now: number = Math.floor(Date.now() / 1000),
): Promise<string> {
	const payload: DownloadJWTPayload = {
		...claims,
		type: 'download',
		iat: now,
		exp: now + lifetimeSeconds,
	};
	return signJWT(payload, secret);
}

export async function verifyDownloadJWT(token: string, secret: string): Promise<DownloadJWTPayload> {
	const payload = await verifyJWT(token, secret);
	if (payload.type !== 'download' || typeof payload.fileId !== 'string') {
		throw new Error('Invalid token type');
	}
	return payload as DownloadJWTPayload;
}

export async function createUploadJWT(sessionId: string, secret: string, now: number = getCurrentTimestamp()): Promise<string> {
	const payload: UploadJWTPayload = {
		sessionId,
		type: 'upload',
		iat: now,
		exp: now + 24 * 60 * 60, // 24 hours
	};

	return signJWT(payload, secret);
}

// Retrieval tokens are short-lived; the page asks again when one runs out
export const RETRIEVAL_TOKEN_SECONDS = 60 * 60;

export async function createChestJWT(sessionId: string, code: string, expiryTimestamp: number | null, secret: string): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const payload: ChestJWTPayload = {
		sessionId,
		code,
		type: 'chest',
		iat: now,
		// Never longer than the chest itself, and never longer than RETRIEVAL_TOKEN_SECONDS
		exp: Math.min(expiryTimestamp ?? Infinity, now + RETRIEVAL_TOKEN_SECONDS),
	};

	return signJWT(payload, secret);
}

export async function verifyUploadJWT(token: string, secret: string): Promise<UploadJWTPayload> {
	const payload = await verifyJWT(token, secret);
	if (payload.type !== 'upload') {
		throw new Error('Invalid token type');
	}
	return payload as UploadJWTPayload;
}

export async function verifyChestJWT(token: string, secret: string): Promise<ChestJWTPayload> {
	const payload = await verifyJWT(token, secret);
	// Tokens issued before the R2-only storage carry no code and must be re-issued via /api/retrieve
	if (payload.type !== 'chest' || typeof payload.code !== 'string') {
		throw new Error('Invalid token type');
	}
	return payload as ChestJWTPayload;
}

export async function createMultipartJWT(
	sessionId: string,
	fileId: string,
	uploadId: string,
	filename: string,
	mimeType: string,
	fileSize: number,
	secret: string,
): Promise<string> {
	const now = Math.floor(Date.now() / 1000);

	// Multipart uploads get 48 hours regardless of session expiry
	const expiry = now + 48 * 60 * 60; // 48 hours

	const payload: MultipartJWTPayload = {
		sessionId,
		fileId,
		uploadId,
		filename,
		mimeType,
		fileSize,
		type: 'multipart',
		iat: now,
		exp: expiry,
	};

	return signJWT(payload, secret);
}

export async function verifyMultipartJWT(token: string, secret: string): Promise<MultipartJWTPayload> {
	const payload = await verifyJWT(token, secret);
	if (payload.type !== 'multipart') {
		throw new Error('Invalid token type');
	}
	return payload as MultipartJWTPayload;
}

// Validate UUID format
export function isValidUUID(uuid: string): boolean {
	const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
	return uuidRegex.test(uuid);
}

// Validate retrieval code format
export function isValidRetrievalCode(code: string): boolean {
	const codeRegex = /^[A-Z0-9]{6}$/;
	return codeRegex.test(code);
}

export const VALIDITY_DAYS_OPTIONS = [1, 3, 7, 14, -1] as const;

export function isValidValidityDays(value: unknown): value is (typeof VALIDITY_DAYS_OPTIONS)[number] {
	return VALIDITY_DAYS_OPTIONS.includes(value as (typeof VALIDITY_DAYS_OPTIONS)[number]);
}

// Build a Content-Disposition header that is safe for any filename (RFC 6266 / RFC 5987)
export function contentDisposition(filename: string): string {
	// eslint-disable-next-line no-control-regex
	const cleaned = filename.replace(/[\x00-\x1f\x7f"\\/]/g, '_').trim() || 'download';
	const asciiFallback = cleaned.replace(/[^\x20-\x7e]/g, '_');
	const encoded = encodeURIComponent(cleaned).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
	return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

// Calculate expiry timestamp
export function calculateExpiry(validityDays: number): number | null {
	if (validityDays === -1) {
		return null; // Permanent
	}
	return Math.floor(Date.now() / 1000) + validityDays * 24 * 60 * 60;
}

// Get current timestamp
export function getCurrentTimestamp(): number {
	return Math.floor(Date.now() / 1000);
}
