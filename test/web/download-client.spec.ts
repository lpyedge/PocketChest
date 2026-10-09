import { describe, it, expect, vi, afterEach } from 'vitest';
import { PocketChestAPI } from '../../src/web/shared/lib/api';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('download authorization from the client', () => {
	it('authorizes a file with the retrieval token in the header and the file id in the body', async () => {
		const calls: { url: string; init: RequestInit }[] = [];
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
			calls.push({ url: String(url), init: init as RequestInit });
			return new Response('', { status: 200, headers: { 'Set-Cookie': 'pc_dl_x=1; Path=/api/download/x' } });
		});

		await new PocketChestAPI('').authorizeDownload('00000000-0000-4000-8000-000000000001', 'RETRIEVAL.TOKEN.VALUE');

		expect(calls[0].url).toBe('/api/download/authorize');
		expect(calls[0].url).not.toContain('token');
		expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer RETRIEVAL.TOKEN.VALUE');
		expect(JSON.parse(calls[0].init.body as string)).toEqual({ fileId: '00000000-0000-4000-8000-000000000001' });
	});

	it('reads text content by authorizing first and then fetching without any token in the URL', async () => {
		const urls: string[] = [];
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
			urls.push(String(url));
			return urls.length === 1 ? new Response('{}', { status: 200 }) : new Response('hello text', { status: 200 });
		});

		const text = await new PocketChestAPI('').downloadTextContent('00000000-0000-4000-8000-000000000002', 'TOKEN');

		expect(text).toBe('hello text');
		expect(urls).toEqual(['/api/download/authorize', '/api/download/00000000-0000-4000-8000-000000000002']);
		expect(urls.some((url) => url.includes('token='))).toBe(false);
	});

	it('does not offer the retired whole-file Blob download', () => {
		const api = new PocketChestAPI('') as unknown as Record<string, unknown>;
		expect(api.downloadFile).toBeUndefined();
		expect(api.triggerDownload).toBeUndefined();
	});
});

describe('retrieval can be cancelled when the code changes', () => {
	it('aborts the retrieval request when its signal fires', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					(init as RequestInit).signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
				}),
		);
		const controller = new AbortController();
		const pending = new PocketChestAPI('').retrieveChest('ABC123', controller.signal);
		controller.abort();

		await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
	});
});
