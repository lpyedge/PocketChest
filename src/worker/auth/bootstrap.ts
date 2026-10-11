/**
 * First setup. The Worker generates the first owner password: 32 random bytes, base64url, stored once in a private R2
 * object (auth/initial-owner-password.txt, create-only). The owner record keeps only its keyed hash, and no person
 * types a password. The generated path runs only when the deployer has armed setup (SETUP_ARMED, set by
 * scripts/deploy-core.mjs after the bucket was proven private), so an unauthenticated request cannot make a credential
 * on an unchecked bucket. An older installation's ADMIN_BOOTSTRAP_PASSWORD secret is never used to create an owner.
 *
 * Setup is claimed in this order:
 *   1. the credential is made (create-only); if another request made it first, that one is used
 *   2. the marker is written with If-None-Match, so only one request can ever claim setup
 *   3. the owner record is created with If-None-Match
 * A stopped attempt is finished with the same credential on the next request. If step 3 fails the marker stays and
 * setup never reopens by itself: the deployer clears the marker with scripts/recover-bootstrap.mjs (docs/RECOVERY.md).
 * An existing owner always closes setup for good; nothing here can change or replace it.
 */
import { toBase64Url } from './encoding';
import { buildFirstOwner, loadOwner, OWNER_KEY, storeFirstOwner } from './owner';
import { verifyPassword } from './password';

export const BOOTSTRAP_MARKER_KEY = 'auth/bootstrap-marker';
export const INITIAL_PASSWORD_KEY = 'auth/initial-owner-password.txt';

export interface BootstrapEnv {
	R2_STORAGE: R2Bucket;
	// Optional kill switch: only the exact value "false" turns automatic setup off
	BOOTSTRAP_ENABLED?: string;
	// Set by the deployer only after the bucket was proven private: the exact value "yes" arms generated setup
	SETUP_ARMED?: string;
	// Root secret the password hash is keyed with
	JWT_SECRET: string;
}

/**
 * ready              an owner exists; sign-in works
 * initializing       another request is creating the owner right now; try again in a moment
 * password-missing   no owner, and the deployment has no usable setup password
 * recovery-required  setup was claimed earlier but never finished; the deployer must recover it
 * failed             setup could not be completed this time; nothing was claimed, try again
 */
export type SetupState = 'ready' | 'initializing' | 'password-missing' | 'recovery-required' | 'failed';

// A claim younger than this is another request still working; older means it stopped halfway
const CLAIM_IN_PROGRESS_SECONDS = 60;

export function setupArmed(env: Pick<BootstrapEnv, 'BOOTSTRAP_ENABLED' | 'SETUP_ARMED'>): boolean {
	return env.SETUP_ARMED === 'yes' && env.BOOTSTRAP_ENABLED !== 'false';
}

/** The stored credential, or a new one made now. Create-only: a request that loses the race reads the winner's copy. */
export async function initialPassword(bucket: R2Bucket): Promise<string> {
	const existing = await bucket.get(INITIAL_PASSWORD_KEY);
	if (existing) return existing.text();
	const password = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
	const stored = await bucket.put(INITIAL_PASSWORD_KEY, password, {
		httpMetadata: { contentType: 'text/plain; charset=utf-8' },
		onlyIf: new Headers({ 'If-None-Match': '*' }),
	});
	if (stored !== null) return password;
	const winner = await bucket.get(INITIAL_PASSWORD_KEY);
	if (!winner) throw new Error('the initial password was not readable after another request stored it');
	return winner.text();
}

/**
 * Removes the initial credential once the owner password has been changed (it no longer signs in). Only that one
 * exact object is deleted. A failed delete is retried by the next call, so cleanup is never lost. Sign-in is never
 * blocked by this: errors are logged by name only and the credential stays until a later call succeeds.
 */
export async function retireInitialPassword(env: Pick<BootstrapEnv, 'R2_STORAGE' | 'JWT_SECRET'>): Promise<void> {
	try {
		if (!(await env.R2_STORAGE.head(INITIAL_PASSWORD_KEY))) return;
		const loaded = await loadOwner(env.R2_STORAGE);
		const credential = await env.R2_STORAGE.get(INITIAL_PASSWORD_KEY);
		if (!loaded || !credential) return;
		const stillValid = await verifyPassword(await credential.text(), loaded.owner.methods.password.hash!, env.JWT_SECRET);
		if (!stillValid) await env.R2_STORAGE.delete(INITIAL_PASSWORD_KEY);
	} catch (error) {
		console.error('Removing the initial password is pending:', error instanceof Error ? error.name : 'error');
	}
}

export async function ensureOwner(env: BootstrapEnv, now: number = Math.floor(Date.now() / 1000)): Promise<SetupState> {
	if (await env.R2_STORAGE.head(OWNER_KEY)) {
		await retireInitialPassword(env);
		return 'ready';
	}

	const marker = await env.R2_STORAGE.head(BOOTSTRAP_MARKER_KEY);
	if (marker) {
		// Claimed, no owner: either a request is finishing right now, or it stopped and needs the deployer
		return now - Math.floor(marker.uploaded.getTime() / 1000) < CLAIM_IN_PROGRESS_SECONDS ? 'initializing' : 'recovery-required';
	}
	if (!setupArmed(env)) return 'password-missing';

	try {
		const owner = await buildFirstOwner(await initialPassword(env.R2_STORAGE), env.JWT_SECRET);
		const claimed = await env.R2_STORAGE.put(BOOTSTRAP_MARKER_KEY, new Date(now * 1000).toISOString(), {
			onlyIf: new Headers({ 'If-None-Match': '*' }),
		});
		if (claimed === null) return 'initializing';
		await storeFirstOwner(env.R2_STORAGE, owner);
		return 'ready';
	} catch (error) {
		console.error('Automatic first setup did not complete:', error instanceof Error ? error.name : 'error');
		return 'failed';
	}
}
