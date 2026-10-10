/**
 * TOTP (RFC 6238: HMAC-SHA1, 6 digits, 30-second steps). The seed is stored only encrypted with
 * AES-256-GCM under a key the Worker derives from its root secret (keys.ts), and a missing or wrong root fails
 * closed. No seed exists until the Owner sets up an authenticator while signed in.
 */
import { ApiError } from '../errors';
import { constantTimeEqual, fromBase64Url, toBase64Url } from './encoding';
import { totpAesKey } from './keys';
import type { EncryptedSecret } from './owner';

const STEP_SECONDS = 30;
const DIGITS = 6;
// One step either side absorbs clock drift between the phone and the server
const WINDOW = 1;
const SEED_BYTES = 20;
const IV_BYTES = 12;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// RFC 4648 base32, the form authenticator apps expect in an otpauth URI
export function base32Encode(bytes: Uint8Array): string {
	let bits = 0;
	let value = 0;
	let out = '';
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += BASE32[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) {
		out += BASE32[(value << (5 - bits)) & 31];
	}
	return out;
}

export function generateSeed(): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(SEED_BYTES));
}

async function codeAtStep(seed: Uint8Array, step: number): Promise<string> {
	const counter = new ArrayBuffer(8);
	new DataView(counter).setBigUint64(0, BigInt(step));
	const key = await crypto.subtle.importKey('raw', seed, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
	const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counter));
	const offset = mac[mac.length - 1] & 0x0f;
	const binary = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
	return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** The code an authenticator app shows at `now` (seconds). Used by tests and by the enrollment flow. */
export async function totpCodeAt(seed: Uint8Array, now: number): Promise<string> {
	return codeAtStep(seed, Math.floor(now / STEP_SECONDS));
}

/**
 * Returns the time step that `code` matches within the window, or null. The caller records this step
 * so that the same step cannot be accepted twice.
 */
export async function matchTotpStep(seed: Uint8Array, code: string, now: number): Promise<number | null> {
	if (!/^\d{6}$/.test(code)) {
		return null;
	}
	const current = Math.floor(now / STEP_SECONDS);
	const encoder = new TextEncoder();
	let matched: number | null = null;
	// Every step is compared, so the time taken does not reveal which step matched
	for (let step = current - WINDOW; step <= current + WINDOW; step++) {
		const expected = await codeAtStep(seed, step);
		if (constantTimeEqual(encoder.encode(expected), encoder.encode(code))) {
			matched = step;
		}
	}
	return matched;
}

export async function sealSeed(seed: Uint8Array, root: string | undefined): Promise<EncryptedSecret> {
	const key = await totpAesKey(root);
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, seed));
	return { v: 1, iv: toBase64Url(iv), ct: toBase64Url(ciphertext) };
}

export async function openSeed(sealed: EncryptedSecret, root: string | undefined): Promise<Uint8Array> {
	const key = await totpAesKey(root);
	try {
		const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64Url(sealed.iv) }, key, fromBase64Url(sealed.ct));
		return new Uint8Array(plain);
	} catch {
		// Wrong key or damaged record: treated as misconfiguration, and nothing about the seed is logged
		throw new ApiError(500, 'AUTH_NOT_CONFIGURED', 'Sign-in is not configured');
	}
}
