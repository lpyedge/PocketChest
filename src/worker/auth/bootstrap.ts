/**
 * Automatic first setup. The deployment carries one secret, ADMIN_BOOTSTRAP_PASSWORD, chosen once by the person who
 * installs. The first request that finds no owner turns it into the owner password (stored only as a keyed hash), so
 * the website never asks for it a second time: it shows the ordinary sign-in. There is no route that lets a caller
 * choose an owner or a password.
 *
 * Setup is claimed in this order:
 *   1. the password is hashed first, so a failure there leaves nothing claimed
 *   2. the marker is written with If-None-Match, so only one request can ever claim setup
 *   3. the owner record is created with If-None-Match
 * If step 3 fails the marker stays and setup never reopens by itself: the site reports that setup must be recovered,
 * and the deployer clears the marker with scripts/recover-bootstrap.mjs (docs/RECOVERY.md). An existing owner always
 * closes setup for good; nothing here can change or replace it.
 */
import { isPlaceholder } from '../config';
import { buildFirstOwner, OWNER_KEY, storeFirstOwner } from './owner';

export const BOOTSTRAP_MARKER_KEY = 'auth/bootstrap-marker';

export interface BootstrapEnv {
	R2_STORAGE: R2Bucket;
	// Optional kill switch: only the exact value "false" turns automatic setup off
	BOOTSTRAP_ENABLED?: string;
	ADMIN_BOOTSTRAP_PASSWORD?: string;
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

export const MIN_BOOTSTRAP_PASSWORD_LENGTH = 16;
// A claim younger than this is another request still working; older means it stopped halfway
const CLAIM_IN_PROGRESS_SECONDS = 60;

export function usableSetupPassword(env: Pick<BootstrapEnv, 'BOOTSTRAP_ENABLED' | 'ADMIN_BOOTSTRAP_PASSWORD'>): string | null {
	const configured = env.ADMIN_BOOTSTRAP_PASSWORD;
	if (env.BOOTSTRAP_ENABLED === 'false' || !configured) return null;
	if (configured.length < MIN_BOOTSTRAP_PASSWORD_LENGTH || isPlaceholder(configured)) return null;
	return configured;
}

export async function ensureOwner(env: BootstrapEnv, now: number = Math.floor(Date.now() / 1000)): Promise<SetupState> {
	if (await env.R2_STORAGE.head(OWNER_KEY)) return 'ready';

	const password = usableSetupPassword(env);
	const marker = await env.R2_STORAGE.head(BOOTSTRAP_MARKER_KEY);
	if (marker) {
		// Claimed, no owner: either a request is finishing right now, or it stopped and needs the deployer
		return now - Math.floor(marker.uploaded.getTime() / 1000) < CLAIM_IN_PROGRESS_SECONDS ? 'initializing' : 'recovery-required';
	}
	if (!password) return 'password-missing';

	try {
		const owner = await buildFirstOwner(password, env.JWT_SECRET);
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
