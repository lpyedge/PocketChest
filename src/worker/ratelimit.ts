import { ApiError } from './errors';
import type { RateLimitBinding } from './types';

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
	const { success } = await limiter.limit({ key: `${route}:${client}` });
	if (!success) {
		throw new ApiError(429, 'RATE_LIMITED', 'Too many requests, slow down', { 'Retry-After': '60' });
	}
}
