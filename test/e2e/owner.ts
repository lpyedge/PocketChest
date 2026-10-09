import { expect, APIRequestContext, Page } from '@playwright/test';

// The dev server is started with this as its bootstrap secret, so it is also the owner's password
export const ORIGIN = 'http://localhost:8788';
export const OWNER_PASSWORD = 'e2e-bootstrap-password-0123456789';

// Each test is its own client, so per-address limits of one test never affect another
export function randomClientIp(): string {
	return `198.51.100.${1 + Math.floor(Math.random() * 250)}`;
}

// Signs in as the owner over the API and returns the headers that owner-only endpoints need
export async function ownerHeaders(request: APIRequestContext, clientIp: string): Promise<Record<string, string>> {
	// Claims the owner on a fresh bucket; later runs get 409 because the owner already exists
	await request.post('/api/auth/bootstrap', { headers: { Origin: ORIGIN }, data: { password: OWNER_PASSWORD } });
	const login = await request.post('/api/auth/login/password', {
		headers: { Origin: ORIGIN, 'CF-Connecting-IP': clientIp },
		data: { password: OWNER_PASSWORD },
	});
	expect(login.status()).toBe(200);
	const cookie = (login.headers()['set-cookie'] ?? '').split(';')[0];
	const { csrfToken } = (await login.json()) as { csrfToken: string };
	return { Origin: ORIGIN, Cookie: cookie, 'X-PocketChest-CSRF': csrfToken, 'CF-Connecting-IP': clientIp };
}

// Gives every request this page makes its own client address
export async function useClientAddress(page: Page, clientIp: string): Promise<void> {
	await page.setExtraHTTPHeaders({ 'CF-Connecting-IP': clientIp });
}
