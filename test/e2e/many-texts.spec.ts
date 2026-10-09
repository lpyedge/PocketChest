import { test, expect, APIRequestContext } from '@playwright/test';
import { ownerHeaders, randomClientIp, useClientAddress } from './owner';

let clientIp = randomClientIp();

test.beforeEach(async ({ page }) => {
	clientIp = randomClientIp();
	await useClientAddress(page, clientIp);
});

// A share of `count` text items (each its own upload: Playwright's multipart cannot repeat a field)
async function chestOfTexts(request: APIRequestContext, count: number): Promise<string> {
	const session = await (await request.post('/api/upload-sessions', { headers: await ownerHeaders(request, clientIp), data: {} })).json();
	const headers = { Authorization: `Bearer ${session.uploadToken}`, 'CF-Connecting-IP': clientIp };
	const fileIds: string[] = [];
	for (let i = 0; i < count; i++) {
		const uploaded = await (
			await request.post(`/api/upload-sessions/${session.sessionId}/files`, {
				headers,
				multipart: { textItems: JSON.stringify({ content: `note number ${i}`, filename: `note-${String(i).padStart(2, '0')}.txt` }) },
			})
		).json();
		fileIds.push(uploaded.uploadedFiles[0].fileId);
	}
	const completed = await (
		await request.post(`/api/upload-sessions/${session.sessionId}/complete`, { headers, data: { fileIds, validityDays: 7 } })
	).json();
	return completed.retrievalCode as string;
}

test('N2-T05/T06: a share of 35 texts asks for at most ten authorizations by itself, and the rest wait for a click', async ({
	page,
	request,
}) => {
	test.setTimeout(90_000);
	const code = await chestOfTexts(request, 35);
	let authorizations = 0;
	page.on('request', (req) => {
		if (req.url().endsWith('/api/download/authorize')) authorizations++;
	});

	await page.goto(`/retrieve/?lang=en#${code}`);
	await expect(page.getByText('note number 0', { exact: true })).toBeVisible();
	await expect(page.getByText('note number 9', { exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Show text' })).toHaveCount(25);
	expect(authorizations).toBeLessThanOrEqual(10);

	await page.getByRole('button', { name: 'Show text' }).first().click();
	await expect(page.getByText('note number 10', { exact: true })).toBeVisible();
});

test('N2-T05: a refused text shows its own message and a retry, and the other texts and the page stay', async ({ page, request }) => {
	test.setTimeout(90_000);
	const code = await chestOfTexts(request, 14);
	await page.goto(`/retrieve/?lang=en#${code}`);
	await expect(page.getByText('note number 9', { exact: true })).toBeVisible();

	// From now on the limiter refuses
	await page.route('**/api/download/authorize', (route) =>
		route.fulfill({
			status: 429,
			contentType: 'application/json',
			body: JSON.stringify({ code: 'RATE_LIMITED', error: 'Too many requests' }),
		}),
	);
	await page.getByRole('button', { name: 'Show text' }).first().click();
	await expect(page.getByRole('alert').filter({ hasText: /Too many requests/ })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Try again' })).toHaveCount(1);
	// Nothing else was disturbed: loaded notes are still there, and the page is not a failure page
	await expect(page.getByText('note number 3', { exact: true })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Retrieval Failed' })).toHaveCount(0);

	// Once the limiter lets go, that one item can be tried again
	await page.unroute('**/api/download/authorize');
	await page.getByRole('button', { name: 'Try again' }).click();
	await expect(page.getByText('note number 10', { exact: true })).toBeVisible();
});

test('N2-T15: switching to another code cancels the texts still being read for the first', async ({ page, request }) => {
	test.setTimeout(90_000);
	const first = await chestOfTexts(request, 6);
	const second = await chestOfTexts(request, 1);
	const authorized: string[] = [];
	await page.route('**/api/download/authorize', async (route) => {
		authorized.push(route.request().headers()['authorization'] ?? '');
		// Slow enough for the switch to happen while the first share's texts are still waiting
		await new Promise((resolve) => setTimeout(resolve, 700));
		await route.continue().catch(() => undefined);
	});

	await page.goto(`/retrieve/?lang=en#${first}`);
	await expect(page.getByText('note-00')).toBeVisible();
	await page.evaluate(
		`window.history.pushState({}, '', '/retrieve/?lang=en#${second}'); window.dispatchEvent(new HashChangeEvent('hashchange'));`,
	);

	await expect(page.getByText('note number 0', { exact: true })).toBeVisible();
	await page.waitForTimeout(2500);
	// Three at a time for the first share, then nothing more of it once the second code is on screen
	expect(authorized.length).toBeLessThanOrEqual(3 + 1);
	await expect(page.getByText('note-05')).toHaveCount(0);
});
