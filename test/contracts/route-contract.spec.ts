import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import apiDoc from '../../docs/API.md?raw';
import { resetStorage, setupTestEnvironment, testFetch, TEST_ORIGIN } from '../utils/test-setup';

// Every row of the endpoint table in docs/API.md is a route: rows marked as removed must answer 404 NOT_FOUND,
// every other row must be a route the Worker knows (it may still refuse the request, with its own code).
const ROW = /^\| \d+ \| (GET|POST|PUT|PATCH|DELETE) \| `(\/api\/[^`]+)` \| [^|]*\| ([^|]*)\|/gm;

interface Row {
	method: string;
	path: string;
	removed: boolean;
}

function documentedRows(): Row[] {
	const rows: Row[] = [];
	for (const match of apiDoc.matchAll(ROW)) {
		const [, method, path, status] = match;
		if (path.includes('…')) continue;
		rows.push({ method, path, removed: status.includes('[已移除]') || status.includes('舊') });
	}
	return rows;
}

describe('route contract (docs/API.md)', () => {
	beforeAll(async () => {
		await resetStorage();
	});

	beforeEach(async () => {
		await setupTestEnvironment();
	});

	it('documents a meaningful set of routes', () => {
		const rows = documentedRows();
		expect(rows.length).toBeGreaterThan(25);
		expect(rows.some((row) => row.path === '/api/chest' || row.path === '/api/config')).toBe(false);
	});

	for (const row of documentedRows()) {
		it(`${row.method} ${row.path} ${row.removed ? 'is gone' : 'exists'}`, async () => {
			const url = `${TEST_ORIGIN}${row.path.replace(/\{[^}]+\}/g, 'fake-id')}`;
			const response = await testFetch(url, {
				method: row.method,
				headers: { Origin: TEST_ORIGIN, 'Content-Type': 'application/json' },
				body: row.method === 'GET' || row.method === 'DELETE' ? undefined : '{}',
			});
			const body = (await response.json().catch(() => ({}))) as { code?: string };
			if (row.removed) {
				expect(response.status).toBe(404);
				expect(body.code).toBe('NOT_FOUND');
			} else {
				expect(body.code === 'NOT_FOUND' && response.status === 404, `${row.method} ${row.path} is not routed`).toBe(false);
			}
		});
	}

	// Retired routes are no longer in docs/API.md, so they are listed here and must answer 404 NOT_FOUND
	const RETIRED: [string, string][] = [
		['POST', '/api/chest'],
		['GET', '/api/config'],
		['GET', '/api/retrieve/ABC123'],
		['POST', '/api/chest/00000000-0000-4000-8000-000000000000/upload'],
	];
	for (const [method, path] of RETIRED) {
		it(`${method} ${path} is retired and answers 404`, async () => {
			const response = await testFetch(`${TEST_ORIGIN}${path}`, {
				method,
				headers: { Origin: TEST_ORIGIN, 'Content-Type': 'application/json' },
				body: method === 'POST' ? '{}' : undefined,
			});
			expect(response.status).toBe(404);
			expect(((await response.json()) as { code?: string }).code).toBe('NOT_FOUND');
		});
	}

	it('does not accept the retired query-string token on download', async () => {
		const byQueryToken = await testFetch(`${TEST_ORIGIN}/api/download/00000000-0000-4000-8000-000000000000?token=abc`);
		expect(byQueryToken.status).toBe(401);
		await byQueryToken.text();
	});

	it('answers the retired retrieval, token and download forms with a refusal, not a result', async () => {
		const byCode = await testFetch(`${TEST_ORIGIN}/api/retrieve/ABC123`);
		expect(byCode.status).toBe(404);
		await byCode.text();

		const byQueryToken = await testFetch(`${TEST_ORIGIN}/api/download/00000000-0000-4000-8000-000000000000?token=abc`);
		expect(byQueryToken.status).toBe(401);
		await byQueryToken.text();
	});
});
