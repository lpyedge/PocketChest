import { constantTimeEqual, fromBase64Url, toBase64Url } from './encoding';
import { passwordHmacKey } from './keys';

/**
 * The one password record format: HMAC-SHA256 over (salt, password) under a key the Worker derives from its root
 * secret (see keys.ts). It is deliberately cheap to compute, because the Workers Free plan allows very little CPU per
 * request. The protection against guessing is therefore two things, not a slow hash: the Owner-level sign-in lockout
 * (auth/throttle.ts), and the key, which is not stored anywhere an R2 reader can see, so a copy of the bucket alone
 * cannot be used to test guesses. Use a long password that is not used elsewhere.
 *
 * There is no other format. Records written by anything else are refused, not converted.
 */
export const PASSWORD_ALGORITHM = 'HMAC-SHA256-KEYED-V1';
const SALT_BYTES = 16;
const DIGEST_BYTES = 32;

export interface PasswordHash {
	alg: typeof PASSWORD_ALGORITHM;
	salt: string;
	hash: string;
}

// Unambiguous input: the salt length comes first, so (salt, password) pairs can never run into each other
async function digest(password: string, salt: Uint8Array, root: string | undefined): Promise<Uint8Array> {
	const passwordBytes = new TextEncoder().encode(password);
	const input = new Uint8Array(4 + salt.length + passwordBytes.length);
	new DataView(input.buffer).setUint32(0, salt.length);
	input.set(salt, 4);
	input.set(passwordBytes, 4 + salt.length);
	return new Uint8Array(await crypto.subtle.sign('HMAC', await passwordHmacKey(root), input));
}

// Every call draws a new random salt; the password itself is never returned or stored
export async function hashPassword(password: string, root: string | undefined): Promise<PasswordHash> {
	const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
	return { alg: PASSWORD_ALGORITHM, salt: toBase64Url(salt), hash: toBase64Url(await digest(password, salt, root)) };
}

// Throws for records it does not understand, instead of accepting them
export async function verifyPassword(password: string, stored: PasswordHash, root: string | undefined): Promise<boolean> {
	if (stored.alg !== PASSWORD_ALGORITHM) {
		throw new Error('Unsupported password hash algorithm');
	}
	const salt = fromBase64Url(stored.salt);
	const expected = fromBase64Url(stored.hash);
	if (salt.length < SALT_BYTES || expected.length !== DIGEST_BYTES) {
		throw new Error('Malformed password record');
	}
	return constantTimeEqual(await digest(password, salt, root), expected);
}
