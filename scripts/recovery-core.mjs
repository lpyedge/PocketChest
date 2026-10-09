// Core of the offline password recovery. Uses only Web Crypto, so the same code runs in Node (the CLI)
// and in the Worker test pool. It has no network or file access; the caller supplies the storage.

export const OWNER_KEY = 'auth/owner.json';
export const PASSWORD_ITERATIONS = 600000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
export const MIN_PASSWORD_LENGTH = 16;

const toBase64Url = (bytes) => {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromBase64Url = (value) => {
	const base64 = value
		.replace(/-/g, '+')
		.replace(/_/g, '/')
		.padEnd(Math.ceil(value.length / 4) * 4, '=');
	return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
};

async function derive(password, salt, iterations) {
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
	const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, KEY_BYTES * 8);
	return new Uint8Array(bits);
}

// Same record format the Worker reads (auth/password.ts): a fresh salt every time
export async function hashNewPassword(password) {
	const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
	const hash = await derive(password, salt, PASSWORD_ITERATIONS);
	return { alg: 'PBKDF2-SHA256', iterations: PASSWORD_ITERATIONS, salt: toBase64Url(salt), hash: toBase64Url(hash) };
}

// Checks the password against a stored record, as the Worker does
export async function passwordMatches(password, stored) {
	const candidate = await derive(password, fromBase64Url(stored.salt), stored.iterations);
	const expected = fromBase64Url(stored.hash);
	if (candidate.length !== expected.length) return false;
	let difference = 0;
	for (let i = 0; i < candidate.length; i++) difference |= candidate[i] ^ expected[i];
	return difference === 0;
}

export async function sha256Hex(text) {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
	return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Only the password method changes. Everything else in the record, including the other methods and the
// stored sharing data, is carried over as it was. authVersion goes up, so every existing session ends.
export function buildRecoveredOwner(owner, passwordHash) {
	if (!owner || owner.schemaVersion !== 1 || !owner.methods || !owner.methods.password || !owner.methods.totp || !owner.methods.passkey) {
		throw new Error('The owner record is not in a format this tool understands; nothing was changed');
	}
	if (!Number.isInteger(owner.authVersion)) {
		throw new Error('The owner record has no valid authVersion; nothing was changed');
	}
	return {
		...owner,
		authVersion: owner.authVersion + 1,
		methods: {
			...owner.methods,
			password: { enabled: true, hash: passwordHash },
		},
	};
}

/**
 * Read, validate, back up, write, verify. `storage` supplies: read() -> { body, etag } | null,
 * write(body) and backup(body). Nothing is written unless the record is unchanged since the first read.
 * Storage without conditional writes (wrangler) can only check this before writing, so the caller must
 * pause the sign-in entrances for the maintenance window; see docs/RECOVERY.md.
 */
export async function recoverPassword(storage, password) {
	if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
		throw new Error(`The new password must be at least ${MIN_PASSWORD_LENGTH} characters`);
	}

	const first = await storage.read();
	if (!first) {
		throw new Error('No owner record exists; recovery needs an existing owner. Nothing was changed');
	}
	let owner;
	try {
		owner = JSON.parse(first.body);
	} catch {
		throw new Error('The owner record is not valid JSON; nothing was changed');
	}
	const original = await sha256Hex(first.body);
	await storage.backup(first.body);

	const next = buildRecoveredOwner(owner, await hashNewPassword(password));
	const nextBody = JSON.stringify(next);

	// The record must still be the one that was validated and backed up
	const second = await storage.read();
	if (!second || (await sha256Hex(second.body)) !== original) {
		throw new Error('The owner record changed during recovery; nothing was written. Try again in a quiet window');
	}

	await storage.write(nextBody);

	const verify = await storage.read();
	if (!verify) {
		throw new Error('The owner record could not be read back after writing');
	}
	const stored = JSON.parse(verify.body);
	if (!stored.methods.password.enabled || !(await passwordMatches(password, stored.methods.password.hash))) {
		throw new Error('The write could not be verified; restore the backup before anything else');
	}
	return { authVersion: stored.authVersion };
}

// The first owner record, in the shape the Worker writes on first setup (auth/owner.ts, buildFirstOwner)
export function buildFirstOwner(passwordHash, now = Math.floor(Date.now() / 1000)) {
	return {
		schemaVersion: 1,
		authVersion: 1,
		createdAt: now,
		methods: {
			password: { enabled: true, hash: passwordHash },
			totp: { enabled: false, encryptedSecret: null, lastAcceptedStep: null },
			passkey: { enabled: false, credentials: [] },
		},
	};
}

/**
 * Finishes a first setup that was interrupted after it claimed the setup marker but before the owner record was
 * written: creates the first owner from a password the deployer supplies. `storage` supplies hasMarker() -> boolean,
 * readOwner() -> { body } | null and writeOwner(body).
 *
 * It runs only in that state. Without the marker, setup was never claimed and /upload/ still offers it; with an
 * owner present, the password tool (reset-owner-password.mjs) is the right one. The marker is never touched, and
 * nothing here is reachable over HTTP. Storage without conditional writes (wrangler) can only check that the owner is
 * still absent just before writing, so the caller must pause the sign-in entrances for the maintenance window.
 */
export async function recoverBootstrap(storage, password, now = Math.floor(Date.now() / 1000)) {
	if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
		throw new Error(`The owner password must be at least ${MIN_PASSWORD_LENGTH} characters`);
	}
	if (!(await storage.hasMarker())) {
		throw new Error('Setup was not interrupted: no setup marker exists, so first setup is still open at /upload/. Nothing was changed');
	}
	if (await storage.readOwner()) {
		throw new Error(
			'An owner already exists, so setup is not interrupted. To change the password use reset-owner-password.mjs. Nothing was changed',
		);
	}

	// The slow part first; the record is checked again right before it is written
	const record = buildFirstOwner(await hashNewPassword(password), now);
	if (await storage.readOwner()) {
		throw new Error('An owner appeared while the password was being hashed; nothing was written');
	}
	await storage.writeOwner(JSON.stringify(record));

	const stored = await storage.readOwner();
	let parsed;
	try {
		parsed = stored ? JSON.parse(stored.body) : null;
	} catch {
		parsed = null;
	}
	if (
		!parsed ||
		parsed.schemaVersion !== 1 ||
		parsed.authVersion !== 1 ||
		!parsed.methods?.password?.enabled ||
		!(await passwordMatches(password, parsed.methods.password.hash))
	) {
		throw new Error(
			'The owner record could not be verified after writing (read back failed or does not match); check auth/owner.json before anything else',
		);
	}
	return { authVersion: parsed.authVersion };
}
