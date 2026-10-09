/**
 * One-time initial setup. The bootstrap password from the deployment secret becomes the first owner
 * password (stored only as a hash). Setup is claimed in this order:
 *   1. the marker is written with If-None-Match, so only one request can ever claim setup
 *   2. the owner record is created with If-None-Match
 * If step 2 fails, the marker stays: setup never reopens by itself. The deployer finishes it offline with
 * scripts/recover-bootstrap.mjs (docs/RECOVERY.md), which creates the first owner and leaves the marker alone.
 * The password is hashed before step 1, so a failure there leaves nothing claimed.
 */
import { ApiError } from '../errors';
import { isPlaceholder } from '../config';
import { constantTimeEqual } from './encoding';
import { buildFirstOwner, OWNER_KEY, storeFirstOwner } from './owner';

export const BOOTSTRAP_MARKER_KEY = 'auth/bootstrap-marker';

export interface BootstrapEnv {
	R2_STORAGE: R2Bucket;
	BOOTSTRAP_ENABLED?: string;
	ADMIN_BOOTSTRAP_PASSWORD?: string;
}

const MIN_BOOTSTRAP_PASSWORD_LENGTH = 16;

export async function bootstrapOwner(env: BootstrapEnv, submitted: string): Promise<void> {
	const configured = env.ADMIN_BOOTSTRAP_PASSWORD;
	if (env.BOOTSTRAP_ENABLED !== 'true' || !configured) {
		throw new ApiError(403, 'BOOTSTRAP_DISABLED', 'Initial setup is not enabled on this deployment');
	}

	if (configured.length < MIN_BOOTSTRAP_PASSWORD_LENGTH || isPlaceholder(configured)) {
		// The setup secret is the only thing between the internet and the owner account while setup is open
		throw new ApiError(500, 'BOOTSTRAP_MISCONFIGURED', 'The setup password configured on this deployment is too short');
	}
	if (await env.R2_STORAGE.head(OWNER_KEY)) {
		throw new ApiError(409, 'BOOTSTRAP_CLOSED', 'Initial setup is already complete');
	}
	if (await env.R2_STORAGE.head(BOOTSTRAP_MARKER_KEY)) {
		throw new ApiError(409, 'AUTH_RECOVERY_REQUIRED', 'Initial setup was interrupted; the deployment administrator must recover it');
	}

	const encoder = new TextEncoder();
	if (!constantTimeEqual(encoder.encode(submitted), encoder.encode(configured))) {
		throw new ApiError(401, 'AUTH_INVALID_CREDENTIALS', 'Invalid credentials');
	}

	// The costly part (hashing the password) comes first. If it fails, for example for lack of CPU, nothing has been
	// claimed yet, so setup can simply be tried again. Only the cheap writes are left once the marker exists.
	const owner = await buildFirstOwner(configured);

	const claimed = await env.R2_STORAGE.put(BOOTSTRAP_MARKER_KEY, new Date().toISOString(), {
		onlyIf: new Headers({ 'If-None-Match': '*' }),
	});
	if (claimed === null) {
		throw new ApiError(409, 'BOOTSTRAP_CLOSED', 'Initial setup is already complete');
	}

	const created = await storeFirstOwner(env.R2_STORAGE, owner);
	if (!created) {
		throw new ApiError(409, 'BOOTSTRAP_CLOSED', 'Initial setup is already complete');
	}
}
