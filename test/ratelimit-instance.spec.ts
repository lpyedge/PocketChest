import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { enforceRateLimit, resetRateLimitScope, resolveRateLimitScope } from '../src/worker/ratelimit';
import type { RateLimitBinding } from '../src/worker/types';
import { resetStorage } from './utils/test-setup';

const request = (ip = '203.0.113.9', host = 'example.com') => new Request(`https://${host}/api/x`, { headers: { 'CF-Connecting-IP': ip } });

// The test binding carries INSTANCE_ID, which the generated Env type does not list
const cfg = env as unknown as { INSTANCE_ID?: string };

function recorder(): { binding: RateLimitBinding; keys: string[] } {
	const keys: string[] = [];
	return {
		keys,
		binding: {
			limit: async ({ key }) => {
				keys.push(key);
				return { success: true };
			},
		},
	};
}

async function keyFor(host = 'example.com', ip = '203.0.113.9') {
	const { binding, keys } = recorder();
	await resolveRateLimitScope(env);
	await enforceRateLimit(binding, request(ip, host), 'download');
	return keys[0];
}

describe('rate limit keys are scoped to the installation', () => {
	const original = cfg.INSTANCE_ID;
	beforeEach(async () => {
		await resetStorage();
		resetRateLimitScope();
	});
	afterEach(() => {
		cfg.INSTANCE_ID = original;
		resetRateLimitScope();
	});

	it('two installations (two buckets) do not share a counter for the same route and address', async () => {
		cfg.INSTANCE_ID = undefined;
		const first = await keyFor();
		await resetStorage(); // a different installation has its own, empty bucket
		resetRateLimitScope();
		const second = await keyFor();
		expect(first).not.toBe(second);
		expect(first).toMatch(/^[0-9a-f]{16}:download:203\.0\.113\.9$/);
	});

	it('the same installation keeps one id: across requests, restarts of the Worker, and hostnames', async () => {
		cfg.INSTANCE_ID = undefined;
		const viaWorkersDev = await keyFor('pocket-chest.example.workers.dev');
		resetRateLimitScope(); // a new isolate reads the stored id
		const viaCustomDomain = await keyFor('share.example.com');
		expect(viaCustomDomain).toBe(viaWorkersDev);
	});

	it('creates the id once in the bucket and does not rewrite it', async () => {
		cfg.INSTANCE_ID = undefined;
		await keyFor();
		const first = await (await env.R2_STORAGE.get('maintenance/instance-id'))!.text();
		resetRateLimitScope();
		await keyFor();
		expect(await (await env.R2_STORAGE.get('maintenance/instance-id'))!.text()).toBe(first);
	});

	it('an explicit INSTANCE_ID wins and touches no storage', async () => {
		cfg.INSTANCE_ID = 'my-own-id';
		expect(await keyFor()).toBe('my-own-id:download:203.0.113.9');
		expect(await env.R2_STORAGE.head('maintenance/instance-id')).toBeNull();
	});

	it('still limits, under a shared prefix, when the bucket cannot be read', async () => {
		cfg.INSTANCE_ID = undefined;
		const broken = {
			...env,
			R2_STORAGE: {
				get: async () => {
					throw new Error('down');
				},
			},
		} as unknown as typeof env;
		await resolveRateLimitScope(broken);
		const { binding, keys } = recorder();
		await enforceRateLimit(binding, request(), 'download');
		expect(keys).toEqual(['shared:download:203.0.113.9']);
	});

	it('counts clients separately within one installation', async () => {
		cfg.INSTANCE_ID = 'x';
		expect(await keyFor('example.com', '203.0.113.1')).not.toBe(await keyFor('example.com', '203.0.113.2'));
	});
});
