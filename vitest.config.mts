import { mkdirSync } from 'node:fs';
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

// wrangler.jsonc points assets at ./dist; API tests don't need a frontend build, only the directory
mkdirSync('./dist', { recursive: true });

export default defineWorkersConfig({
	test: {
		include: ['test/**/*.spec.ts'],
		poolOptions: {
			workers: {
				wrangler: { configPath: './wrangler.jsonc' },
				miniflare: {
					// Default test environment variables - can be overridden in individual tests
					vars: {
						REQUIRE_TOTP: 'false',
						JWT_SECRET: 'test-jwt-secret-for-vitest-only',
					},
				},
			},
		},
	},
});
