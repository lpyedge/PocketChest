import { defineConfig, devices } from '@playwright/test';

// PLAYWRIGHT_CHROMIUM_PATH lets a machine with a pre-installed browser run the suite
// without downloading one. In CI, `npx playwright install chromium` provides it.
const chromiumPath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
const launchOptions = chromiumPath ? { executablePath: chromiumPath } : {};

export default defineConfig({
	testDir: 'test/e2e',
	fullyParallel: true,
	forbidOnly: !!process.env.CI,
	reporter: [['list']],
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
		// Serve the real Worker and its static assets, exactly as deployed
		command: 'npm run build && npx wrangler dev --port 8788',
		url: 'http://localhost:8788/',
		reuseExistingServer: !process.env.CI,
		timeout: 120_000,
	},
});
