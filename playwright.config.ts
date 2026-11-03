import { defineConfig, devices } from '@playwright/test';

// PLAYWRIGHT_CHROMIUM_PATH lets a machine with a pre-installed browser run the suite
// without downloading one. In CI, `npx playwright install chromium` provides it.
const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
const launchOptions = chromiumPath ? { executablePath: chromiumPath } : {};

export default defineConfig({
	testDir: 'test/e2e',
	// All tests share one owner on one dev server. A security change (method switch, authenticator setup) ends the
	// owner's other sessions by design, so tests run one at a time instead of ending each other's sessions.
	fullyParallel: false,
	workers: 1,
	forbidOnly: !!process.env.CI,
	reporter: [['list']],
	outputDir: '.temp/test-results',
	use: {
		baseURL: 'http://localhost:8788',
		trace: 'retain-on-failure',
	},
	projects: [
		{
			name: 'desktop',
			use: { ...devices['Desktop Chrome'], launchOptions },
		},
		{
			name: 'mobile-375',
			use: {
				...devices['Desktop Chrome'],
				viewport: { width: 375, height: 667 },
				isMobile: true,
				hasTouch: true,
				launchOptions,
			},
		},
	],
	webServer: {
		// Serve the real Worker and its static assets, exactly as deployed.
		// A test credential is seeded before the first status check, so the owner gets this password and the suite can sign in.
		// Local R2 state lives in .temp/e2e-state, isolated from the developer's own `wrangler dev` on :8787:
		// changing the owner password in one never breaks sign-in for the other.
		command:
			'npm run build && mkdir -p .wrangler .temp/e2e-state && printf %s e2e-bootstrap-password-0123456789 > .wrangler/e2e-owner.txt && npx wrangler r2 object put pocket-chest/auth/initial-owner-password.txt --local --persist-to .temp/e2e-state --file .wrangler/e2e-owner.txt && npx wrangler dev --port 8788 --persist-to .temp/e2e-state --var BOOTSTRAP_ENABLED:true --var SETUP_ARMED:yes --var JWT_SECRET:e2e-jwt-secret-for-playwright-only',
		url: 'http://localhost:8788/',
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
	},
});
