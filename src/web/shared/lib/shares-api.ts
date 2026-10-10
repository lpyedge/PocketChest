// Owner calls for the share records. Same rules as auth-api: cookies travel on their own, changes echo the CSRF token.
// The retrieval code only appears in the response body, never in a URL or in storage.
import { AuthRequestError } from './auth-api';
import type { ValidityDays } from './types';

export interface ShareRecord {
	sessionId: string;
	retrievalCode: string;
	createdAt: number;
	expiresAt: number | null;
	fileCount: number;
	totalSize: number;
}

export interface SharePage {
	shares: ShareRecord[];
	cursor: string | null;
}

async function call<T>(method: string, path: string, options: { csrf?: string; body?: unknown } = {}): Promise<T> {
	const headers: Record<string, string> = {};
	if (options.body !== undefined) headers['Content-Type'] = 'application/json';
	if (options.csrf) headers['X-PocketChest-CSRF'] = options.csrf;
	const response = await fetch(path, {
		method,
		headers,
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	});
	const data = (await response.json().catch(() => ({}))) as { code?: string };
	if (!response.ok) {
		throw new AuthRequestError(response.status, data.code ?? 'UNKNOWN', 'Request failed', null);
	}
	return data as T;
}

export const sharesApi = {
	list: (cursor?: string | null) =>
		call<SharePage>('GET', `/api/admin/shares?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
	extend: (csrf: string, sessionId: string, validityDays: ValidityDays) =>
		call<{ expiresAt: number | null }>('PATCH', `/api/admin/shares/${encodeURIComponent(sessionId)}`, { csrf, body: { validityDays } }),
	revoke: (csrf: string, sessionId: string) =>
		call<{ revoked: boolean; contentRemoved: boolean }>('DELETE', `/api/admin/shares/${encodeURIComponent(sessionId)}`, { csrf }),
};
