/**
 * The owner record: the only source of truth for sign-in. It holds the state of all three methods
 * (password, TOTP, passkeys) in one object, so one conditional write changes them together.
 *
 * Invariant (INV-5): at least one method is enabled AND configured. Every committed state is checked.
 */
import { hashPassword, PASSWORD_ALGORITHM, PasswordHash } from './password';

export const OWNER_KEY = 'auth/owner.json';
export type Method = 'password' | 'totp' | 'passkey';

export interface EncryptedSecret {
	v: 1;
	iv: string;
	ct: string;
}

export interface PasskeyCredential {
	id: string;
	publicKey: string;
	counter: number;
	label: string;
	createdAt: number;
	lastUsedAt: number | null;
	transports: string[];
}

export interface OwnerRecord {
	schemaVersion: 1;
	authVersion: number;
	createdAt: number;
	methods: {
		password: { enabled: boolean; hash: PasswordHash | null };
		totp: { enabled: boolean; encryptedSecret: EncryptedSecret | null; lastAcceptedStep: number | null };
		passkey: { enabled: boolean; credentials: PasskeyCredential[] };
	};
}

export class OwnerCorruptError extends Error {}
export class OwnerMissingError extends Error {}
export class OwnerConflictError extends Error {}
export class OwnerInvariantError extends Error {}

export function isConfigured(owner: OwnerRecord, method: Method): boolean {
	switch (method) {
		case 'password':
			return owner.methods.password.hash !== null;
		case 'totp':
			return owner.methods.totp.encryptedSecret !== null;
		case 'passkey':
			return owner.methods.passkey.credentials.length > 0;
	}
}

export function isUsable(owner: OwnerRecord, method: Method): boolean {
	const enabled = owner.methods[method].enabled;
	return enabled && isConfigured(owner, method);
}

export function assertInvariant(owner: OwnerRecord): void {
	if (!(['password', 'totp', 'passkey'] as Method[]).some((method) => isUsable(owner, method))) {
		throw new OwnerInvariantError('At least one sign-in method must stay enabled and configured');
	}
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isInteger = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);

function isPasswordHash(value: unknown): value is PasswordHash {
	return isObject(value) && value.alg === PASSWORD_ALGORITHM && typeof value.salt === 'string' && typeof value.hash === 'string';
}

function isEncryptedSecret(value: unknown): value is EncryptedSecret {
	return isObject(value) && value.v === 1 && typeof value.iv === 'string' && typeof value.ct === 'string';
}

function isCredential(value: unknown): value is PasskeyCredential {
	return (
		isObject(value) &&
		typeof value.id === 'string' &&
		typeof value.publicKey === 'string' &&
		isInteger(value.counter) &&
		typeof value.label === 'string' &&
		isInteger(value.createdAt) &&
		(value.lastUsedAt === null || isInteger(value.lastUsedAt)) &&
		Array.isArray(value.transports) &&
		value.transports.every((transport) => typeof transport === 'string')
	);
}

// Strict: any field that does not match the schema makes the whole record unusable (fail closed)
export function parseOwner(value: unknown): OwnerRecord {
	const corrupt = (): never => {
		throw new OwnerCorruptError('Owner record failed validation');
	};
	if (
		!isObject(value) ||
		value.schemaVersion !== 1 ||
		!isInteger(value.authVersion) ||
		value.authVersion < 1 ||
		!isInteger(value.createdAt)
	) {
		return corrupt();
	}
	const methods = value.methods;
	if (!isObject(methods)) return corrupt();

	const password = methods.password;
	const totp = methods.totp;
	const passkey = methods.passkey;
	if (
		!isObject(password) ||
		typeof password.enabled !== 'boolean' ||
		!(password.hash === null || isPasswordHash(password.hash)) ||
		!isObject(totp) ||
		typeof totp.enabled !== 'boolean' ||
		!(totp.encryptedSecret === null || isEncryptedSecret(totp.encryptedSecret)) ||
		!(totp.lastAcceptedStep === null || isInteger(totp.lastAcceptedStep)) ||
		!isObject(passkey) ||
		typeof passkey.enabled !== 'boolean' ||
		!Array.isArray(passkey.credentials) ||
		!passkey.credentials.every(isCredential)
	) {
		return corrupt();
	}

	return {
		schemaVersion: 1,
		authVersion: value.authVersion,
		createdAt: value.createdAt,
		methods: {
			password: { enabled: password.enabled, hash: password.hash as PasswordHash | null },
			totp: {
				enabled: totp.enabled,
				encryptedSecret: totp.encryptedSecret as EncryptedSecret | null,
				lastAcceptedStep: totp.lastAcceptedStep as number | null,
			},
			passkey: { enabled: passkey.enabled, credentials: passkey.credentials as PasskeyCredential[] },
		},
	};
}

/** Reads the owner record with its ETag. Returns null when there is no owner yet. */
export async function loadOwner(bucket: R2Bucket): Promise<{ owner: OwnerRecord; etag: string } | null> {
	const object = await bucket.get(OWNER_KEY);
	if (!object) {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(await object.text());
	} catch {
		throw new OwnerCorruptError('Owner record is not valid JSON');
	}
	return { owner: parseOwner(parsed), etag: object.etag };
}

/** The first owner record, with the password as the only enabled method. This is where the expensive hashing happens. */
export async function buildFirstOwner(password: string, root: string, now: number = Math.floor(Date.now() / 1000)): Promise<OwnerRecord> {
	const owner: OwnerRecord = {
		schemaVersion: 1,
		authVersion: 1,
		createdAt: now,
		methods: {
			password: { enabled: true, hash: await hashPassword(password, root) },
			totp: { enabled: false, encryptedSecret: null, lastAcceptedStep: null },
			passkey: { enabled: false, credentials: [] },
		},
	};
	assertInvariant(owner);
	return owner;
}

/** Stores a record built by buildFirstOwner, only if there is no owner yet. Returns false if one exists. */
export async function storeFirstOwner(bucket: R2Bucket, owner: OwnerRecord): Promise<boolean> {
	const stored = await bucket.put(OWNER_KEY, JSON.stringify(owner), {
		httpMetadata: { contentType: 'application/json' },
		onlyIf: new Headers({ 'If-None-Match': '*' }),
	});
	return stored !== null;
}

/** Creates the first owner, with the password as the only enabled method. Returns false if one exists. */
export async function createOwnerOnce(
	bucket: R2Bucket,
	password: string,
	root: string,
	now: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
	return storeFirstOwner(bucket, await buildFirstOwner(password, root, now));
}

/**
 * Applies `mutate` to the owner record. The write is conditional on the ETag that was read, so a
 * concurrent change makes this read again and apply `mutate` to the newer state.
 */
export async function mutateOwner(bucket: R2Bucket, mutate: (owner: OwnerRecord) => OwnerRecord, attempts = 20): Promise<OwnerRecord> {
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (attempt > 0) {
			// Short random pause so that competing writers do not keep colliding in lockstep
			await new Promise((resolve) => setTimeout(resolve, Math.random() * 10 * attempt));
		}
		const current = await loadOwner(bucket);
		if (!current) {
			throw new OwnerMissingError('No owner exists yet');
		}
		const next = parseOwner(mutate(structuredClone(current.owner)));
		assertInvariant(next);
		const stored = await bucket.put(OWNER_KEY, JSON.stringify(next), {
			httpMetadata: { contentType: 'application/json' },
			onlyIf: { etagMatches: current.etag },
		});
		if (stored !== null) {
			return next;
		}
	}
	throw new OwnerConflictError('Owner record changed concurrently; try again');
}
