// Core of the offline recovery tools. Web Crypto only, so the same code runs in Node (the CLIs) and in the Worker
// test pool. It has no network or file access; the caller supplies the storage.
//
// Passwords are stored as an HMAC under a key the Worker derives from its root secret (src/worker/auth/password.ts).
// Cloudflare never shows that secret, so no tool that only holds R2 access can produce a password record the Worker
// would accept. Resetting the password offline is therefore refused, and nothing is read or written. The Owner changes
// the password in Security settings while signed in. What can still be done offline is clearing the marker of a first
// setup that was interrupted, which needs no password and no secret.

export const OWNER_KEY = 'auth/owner.json';
export const BOOTSTRAP_MARKER_KEY = 'auth/bootstrap-marker';

export const OFFLINE_RESET_UNSUPPORTED =
	'Resetting the Owner password offline is not possible: the password record is keyed with a secret that only the ' +
	'Worker holds, so a tool with R2 access alone cannot write a record the Worker would accept. Nothing was read or ' +
	'changed. Sign in and use Security settings > Change password. If no sign-in method works at all, see docs/RECOVERY.md.';

/** Refuses, before touching `storage`. Kept so existing callers fail with an explanation, never with a false success. */
export async function recoverPassword(..._ignored) {
	throw new Error(OFFLINE_RESET_UNSUPPORTED);
}

/**
 * Reopens first setup after it was interrupted between claiming the marker and writing the Owner (the site then says
 * the administrator must recover it). Removes only the marker, and only in exactly that state; nothing is created, so
 * no password is involved here. The next setup still needs the deployment's own setup password. `storage` supplies
 * hasMarker() -> boolean, readOwner() -> { body } | null and clearMarker(). Storage without conditional deletes
 * (wrangler) can only check that the Owner is still absent just before deleting, so the caller must pause the
 * sign-in entrances for the maintenance window (docs/RECOVERY.md).
 */
export async function recoverBootstrap(storage) {
	if (!(await storage.hasMarker())) {
		throw new Error('Setup was not interrupted: no setup marker exists, so first setup is still open. Nothing was changed');
	}
	if (await storage.readOwner()) {
		throw new Error(
			'An owner already exists, so setup is not interrupted and the marker must stay. The password can only be changed in Security settings after signing in. Nothing was changed',
		);
	}
	await storage.clearMarker();
	if ((await storage.hasMarker()) || (await storage.readOwner())) {
		throw new Error('The marker could not be verified as removed, or an owner appeared; check auth/bootstrap-marker and auth/owner.json');
	}
	return { markerCleared: true };
}
