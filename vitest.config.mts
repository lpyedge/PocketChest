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
					JWT_SECRET: 'test-jwt-secret-for-vitest-only',
					INSTANCE_ID: 'test-instance',
					BOOTSTRAP_ENABLED: 'true',
					ADMIN_BOOTSTRAP_PASSWORD: 'test-bootstrap-password-0123456789',
				},
			},
		}),
	],
	test: {
		include: ['test/**/*.spec.ts'],
		exclude: ['test/e2e/**', 'node_modules/**'],
		// Sign-in tests hash passwords with 600,000 PBKDF2 rounds many times over; a slow machine needs more than 5 seconds
		testTimeout: 60_000,
	},
});
