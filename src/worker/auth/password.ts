import { constantTimeEqual, fromBase64Url, toBase64Url } from './encoding';

// PBKDF2-HMAC-SHA256 at the OWASP recommended cost. Web Crypto runs it natively in the Worker
// (about 0.1 s per hash locally), so the cost is not reduced to fit the runtime.
export const PASSWORD_ITERATIONS = 600000;
const MIN_ITERATIONS = 600000;
const MAX_ITERATIONS = 2000000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

export interface PasswordHash {
	alg: 'PBKDF2-SHA256';
	iterations: number;
	salt: string;
	hash: string;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
	const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, KEY_BYTES * 8);
	return new Uint8Array(bits);
}

// Every call draws a new random salt; the password itself is never returned or stored
export async function hashPassword(password: string, iterations: number = PASSWORD_ITERATIONS): Promise<PasswordHash> {
	const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
	const hash = await derive(password, salt, iterations);
	return { alg: 'PBKDF2-SHA256', iterations, salt: toBase64Url(salt), hash: toBase64Url(hash) };
}

// Throws for records it does not understand, instead of accepting them
export async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
	if (stored.alg !== 'PBKDF2-SHA256') {
		throw new Error('Unsupported password hash algorithm');
	}
	if (!Number.isInteger(stored.iterations) || stored.iterations < MIN_ITERATIONS || stored.iterations > MAX_ITERATIONS) {
		throw new Error('Password hash cost is outside the accepted range');
	}
	const candidate = await derive(password, fromBase64Url(stored.salt), stored.iterations);
	return constantTimeEqual(candidate, fromBase64Url(stored.hash));
}
