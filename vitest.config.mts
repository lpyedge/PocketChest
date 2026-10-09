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
					BOOTSTRAP_ENABLED: 'true',
					ADMIN_BOOTSTRAP_PASSWORD: 'test-bootstrap-password-0123456789',
					AUTH_ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
				},
			},
		}),
	],
	test: {
		include: ['test/**/*.spec.ts'],
		exclude: ['test/e2e/**', 'node_modules/**'],
	},
});
