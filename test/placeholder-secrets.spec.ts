import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resetStorage, setupTestEnvironment, testFetch } from './utils/test-setup';

const e = env as unknown as Record<string, unknown>;
const saved = { jwt: e.JWT_SECRET, enabled: e.BOOTSTRAP_ENABLED, password: e.ADMIN_BOOTSTRAP_PASSWORD };

// The example file names every secret with a REPLACE_WITH_ value, and a deploy button may offer those as defaults.
// A deployment that kept them must refuse to run, not run with a secret that everyone can read in the repository.
describe('values copied from .dev.vars.example are refused', () => {
	beforeEach(async () => {
		await resetStorage();
		await setupTestEnvironment();
	});
	afterEach(() => {
		e.JWT_SECRET = saved.jwt;
		e.BOOTSTRAP_ENABLED = saved.enabled;
		e.ADMIN_BOOTSTRAP_PASSWORD = saved.password;
	});

	const bootstrap = (password: string) =>
		testFetch('http://example.com/api/auth/bootstrap', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Origin: 'http://example.com' },
			body: JSON.stringify({ password }),
		});

	for (const placeholder of [
		'REPLACE_WITH_UNIQUE_PASSWORD_16_CHARS_MINIMUM',
		'replace_with_something_long_enough',
		'change-me-change-me-change-me',
	]) {
		it(`will not create the owner with the setup password "${placeholder}", even when it is typed correctly`, async () => {
			e.BOOTSTRAP_ENABLED = 'true';
			e.ADMIN_BOOTSTRAP_PASSWORD = placeholder;

			const response = await bootstrap(placeholder);

			expect(response.status).toBe(500);
			expect(((await response.json()) as any).code).toBe('BOOTSTRAP_MISCONFIGURED');
			expect(await env.R2_STORAGE.head('auth/owner.json')).toBeNull();
			expect(await env.R2_STORAGE.head('auth/bootstrap-marker')).toBeNull();
		});
	}

	for (const secret of ['REPLACE_WITH_UNIQUE_RANDOM_SECRET', 'change-me-change-me-change-me', 'short', '', undefined]) {
		it(`answers every API call with SERVER_MISCONFIGURED when JWT_SECRET is ${JSON.stringify(secret)}`, async () => {
			e.JWT_SECRET = secret;

			for (const path of ['/api/auth/methods', '/api/retrieve']) {
				const response = await testFetch(`http://example.com${path}`, {
					method: path === '/api/retrieve' ? 'POST' : 'GET',
					body: path === '/api/retrieve' ? '{}' : undefined,
				});
				expect(response.status).toBe(500);
				const body = (await response.json()) as any;
				expect(body.code).toBe('SERVER_MISCONFIGURED');
				// It says what to fix, never what the value was
				if (secret) expect(JSON.stringify(body)).not.toContain(secret);
			}
		});
	}

	it('keeps working with a real secret, and does not touch static pages', async () => {
		e.JWT_SECRET = 'REPLACE_WITH_UNIQUE_RANDOM_SECRET';
		const page = await testFetch('http://example.com/');
		expect(page.status).not.toBe(500);
		await page.text();

		e.JWT_SECRET = 'a-real-random-secret-with-enough-length-0123456789';
		const methods = await testFetch('http://example.com/api/auth/methods');
		expect(methods.status).toBe(200);
		await methods.text();
	});
});
