import { ApiError } from './errors';
import type { RateLimitBinding } from './types';

// The namespace_ids in wrangler.jsonc are shared by every Worker in the same Cloudflare account, so two
// installations would count each other's requests under the same key. Every key therefore starts with an id that is
// unique to this installation and the same on every hostname it answers on (workers.dev and a custom domain count
// together). It is chosen once, stored with the data in the installation's own bucket, and never changes on upgrade.
const INSTANCE_ID_KEY = 'maintenance/instance-id';
const FALLBACK_SCOPE = 'shared';
let scope: string | null = null;

/** Forgets the resolved scope (tests that switch installations). */
export function resetRateLimitScope(): void {
	scope = null;
}

/**
 * Settles the key prefix for this installation. An explicit INSTANCE_ID wins; otherwise a random id is created once
 * in the bucket (conditional write, so two first requests agree). If the bucket cannot be read the requests are still
 * limited, under a shared prefix, and the next request tries again.
 */
export async function resolveRateLimitScope(env: { INSTANCE_ID?: string; R2_STORAGE: R2Bucket }): Promise<void> {
	if (scope !== null) return;
	const explicit = env.INSTANCE_ID?.trim();
	if (explicit) {
		scope = explicit.slice(0, 32);
		return;
	}
	try {
		const existing = await env.R2_STORAGE.get(INSTANCE_ID_KEY);
		let id = existing ? (await existing.text()).trim() : '';
		if (!id) {
			const fresh = [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
			const stored = await env.R2_STORAGE.put(INSTANCE_ID_KEY, fresh, { onlyIf: new Headers({ 'If-None-Match': '*' }) });
			id = stored ? fresh : ((await (await env.R2_STORAGE.get(INSTANCE_ID_KEY))?.text()) ?? '').trim();
		}
		if (/^[0-9a-f]{32}$/.test(id)) scope = id.slice(0, 16);
	} catch (error) {
		console.error('Could not resolve the rate limit scope; using the shared one for now:', error instanceof Error ? error.name : 'error');
	}
}

/**
 * Runtime rate limit for one kind of request, keyed by client address. Cloudflare counts per location,
 * so the limit is approximate across the world. The address is only a bucket key, never an identity:
 * the owner-level lockout in auth/throttle.ts is what protects the owner's sign-in.
 */
export async function enforceRateLimit(limiter: RateLimitBinding | undefined, request: Request, route: string): Promise<void> {
	if (!limiter) {
		throw new ApiError(500, 'RATE_LIMIT_NOT_CONFIGURED', 'Rate limiting is not configured');
	}
	const client = request.headers.get('CF-Connecting-IP') ?? 'unknown';
	const { success } = await limiter.limit({ key: `${scope ?? FALLBACK_SCOPE}:${route}:${client}` });
	if (!success) {
		throw new ApiError(429, 'RATE_LIMITED', 'Too many requests, slow down', { 'Retry-After': '60' });
	}
}
