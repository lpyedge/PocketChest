/**
 * Keys the Worker derives from its one root secret (JWT_SECRET). Each purpose has its own HKDF context, so a key made
 * for one purpose is never valid for another, and nothing here has to be configured, backed up or typed by a person.
 */
import { ApiError } from '../errors';

export type KeyPurpose = 'password-hmac' | 'totp-seed-aes';

const INFO: Record<KeyPurpose, string> = {
	'password-hmac': 'pocketchest/v1/password-hmac',
	'totp-seed-aes': 'pocketchest/v1/totp-seed-aes',
};

const MIN_ROOT_LENGTH = 16;

async function derivedBits(root: string | undefined, purpose: KeyPurpose): Promise<ArrayBuffer> {
	if (typeof root !== 'string' || root.length < MIN_ROOT_LENGTH) {
		throw new ApiError(500, 'AUTH_NOT_CONFIGURED', 'Sign-in is not configured');
	}
	const ikm = await crypto.subtle.importKey('raw', new TextEncoder().encode(root), 'HKDF', false, ['deriveBits']);
	return crypto.subtle.deriveBits(
		{ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode(INFO[purpose]) },
		ikm,
		256,
	);
}

export async function passwordHmacKey(root: string | undefined): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', await derivedBits(root, 'password-hmac'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export async function totpAesKey(root: string | undefined): Promise<CryptoKey> {
	return crypto.subtle.importKey('raw', await derivedBits(root, 'totp-seed-aes'), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
