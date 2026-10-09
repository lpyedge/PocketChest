// A software authenticator for tests. It produces the same byte formats a platform authenticator does
// (none attestation, COSE ES256 keys, authenticator data, DER signatures), so the real verifier is what
// decides whether a response is accepted.

const enc = new TextEncoder();

function head(major: number, length: number): number[] {
	if (length < 24) return [(major << 5) | length];
	if (length < 0x100) return [(major << 5) | 24, length];
	if (length < 0x10000) return [(major << 5) | 25, length >> 8, length & 0xff];
	return [(major << 5) | 26, (length >>> 24) & 0xff, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff];
}

// Minimal CBOR encoder for the shapes WebAuthn uses: integers, byte strings, text, maps
export function cbor(value: unknown): Uint8Array {
	const out: number[] = [];
	const write = (item: unknown): void => {
		if (typeof item === 'number') {
			out.push(...(item >= 0 ? head(0, item) : head(1, -1 - item)));
		} else if (item instanceof Uint8Array) {
			out.push(...head(2, item.length), ...item);
		} else if (typeof item === 'string') {
			const bytes = enc.encode(item);
			out.push(...head(3, bytes.length), ...bytes);
		} else if (item instanceof Map) {
			out.push(...head(5, item.size));
			for (const [key, val] of item) {
				write(key);
				write(val);
			}
		} else if (typeof item === 'object' && item !== null) {
			const entries = Object.entries(item);
			out.push(...head(5, entries.length));
			for (const [key, val] of entries) {
				write(key);
				write(val);
			}
		} else {
			throw new Error('Unsupported CBOR value');
		}
	};
	write(value);
	return new Uint8Array(out);
}

const b64u = (bytes: Uint8Array) => {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const concat = (...parts: Uint8Array[]) => {
	const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
};

const u16 = (n: number) => new Uint8Array([n >> 8, n & 0xff]);
const u32 = (n: number) => new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);

// Raw ECDSA signature (r || s) to the DER form WebAuthn uses
function derSignature(raw: Uint8Array): Uint8Array {
	const integer = (bytes: Uint8Array) => {
		let start = 0;
		while (start < bytes.length - 1 && bytes[start] === 0) start++;
		let body = bytes.slice(start);
		if (body[0] & 0x80) body = concat(new Uint8Array([0]), body);
		return concat(new Uint8Array([0x02, body.length]), body);
	};
	const r = integer(raw.slice(0, 32));
	const s = integer(raw.slice(32, 64));
	return concat(new Uint8Array([0x30, r.length + s.length]), r, s);
}

const sha256 = async (data: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', data));

interface Credential {
	privateKey: CryptoKey;
	counter: number;
}

export interface AuthenticatorOptions {
	origin?: string;
	rpId?: string;
	userVerified?: boolean;
	credentialId?: string;
}

export class VirtualAuthenticator {
	readonly credentials = new Map<string, Credential>();

	constructor(
		private readonly rpId: string,
		private readonly origin: string,
	) {}

	private clientData(type: string, challenge: string, origin: string): Uint8Array {
		return enc.encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
	}

	async register(options: { challenge: string }, overrides: AuthenticatorOptions = {}) {
		const key = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
		const jwk = (await crypto.subtle.exportKey('jwk', key.publicKey)) as JsonWebKey;
		const credentialId = overrides.credentialId ?? b64u(crypto.getRandomValues(new Uint8Array(16)));
		const rawId = Uint8Array.from(atob(credentialId.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
		const cose = cbor(
			new Map<number, unknown>([
				[1, 2],
				[3, -7],
				[-1, 1],
				[-2, Uint8Array.from(atob((jwk.x ?? '').replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))],
				[-3, Uint8Array.from(atob((jwk.y ?? '').replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))],
			]),
		);
		const flags = 0x01 | (overrides.userVerified === false ? 0 : 0x04) | 0x40;
		const authData = concat(
			await sha256(enc.encode(overrides.rpId ?? this.rpId)),
			new Uint8Array([flags]),
			u32(0),
			new Uint8Array(16),
			u16(rawId.length),
			rawId,
			cose,
		);
		const attestationObject = cbor({ fmt: 'none', attStmt: {}, authData });
		this.credentials.set(credentialId, { privateKey: key.privateKey, counter: 0 });

		return {
			id: credentialId,
			rawId: credentialId,
			type: 'public-key' as const,
			clientExtensionResults: {},
			authenticatorAttachment: 'platform' as const,
			response: {
				clientDataJSON: b64u(this.clientData('webauthn.create', options.challenge, overrides.origin ?? this.origin)),
				attestationObject: b64u(attestationObject),
				transports: ['internal'],
			},
		};
	}

	async assert(
		options: { challenge: string; allowCredentials?: { id: string }[] },
		credentialId: string,
		overrides: AuthenticatorOptions = {},
	) {
		const credential = this.credentials.get(credentialId);
		if (!credential) {
			throw new Error('Unknown test credential');
		}
		credential.counter += 1;
		const flags = 0x01 | (overrides.userVerified === false ? 0 : 0x04);
		const authData = concat(await sha256(enc.encode(overrides.rpId ?? this.rpId)), new Uint8Array([flags]), u32(credential.counter));
		const clientData = this.clientData('webauthn.get', options.challenge, overrides.origin ?? this.origin);
		const signed = concat(authData, await sha256(clientData));
		const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, credential.privateKey, signed));

		return {
			id: credentialId,
			rawId: credentialId,
			type: 'public-key' as const,
			clientExtensionResults: {},
			authenticatorAttachment: 'platform' as const,
			response: {
				clientDataJSON: b64u(clientData),
				authenticatorData: b64u(authData),
				signature: b64u(derSignature(raw)),
			},
		};
	}

	counterOf(credentialId: string): number {
		return this.credentials.get(credentialId)?.counter ?? 0;
	}
}
