import { mkdirSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';

// wrangler.jsonc points assets at ./dist; API tests don't need a frontend build, only the directory
mkdirSync('./dist', { recursive: true });

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: './wrangler.jsonc' },
			miniflare: {
				// Default test environment variables - can be overridden in individual tests
				bindings: {
					REQUIRE_TOTP: 'false',
					JWT_SECRET: 'test-jwt-secret-for-vitest-only',
				},
			},
		}),
	],
	test: {
		include: ['test/**/*.spec.ts'],
	},
});
