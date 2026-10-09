import { describe, it, expect, vi, afterEach } from 'vitest';
import { PocketChestAPI } from '../../src/web/shared/lib/api';
import { normalizeRetrievalCode, parseCodeFromHash } from '../../src/web/shared/lib/share';

afterEach(() => {
	vi.restoreAllMocks();
});

describe('retrieving a chest', () => {
	it('posts the code in the JSON body, and the URL does not contain it', async () => {
		const calls: { url: string; init: RequestInit }[] = [];
		vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
			calls.push({ url: String(url), init: init as RequestInit });
			return new Response(JSON.stringify({ files: [], chestToken: 't', expiryDate: null }), { status: 200 });
		});

		await new PocketChestAPI('').retrieveChest('ABC123');

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe('/api/retrieve');
		expect(calls[0].url).not.toContain('ABC123');
		expect(calls[0].init.method).toBe('POST');
		expect(JSON.parse(calls[0].init.body as string)).toEqual({ code: 'ABC123' });
	});

	it('maps a 404 to a readable error', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ code: 'CHEST_NOT_FOUND' }), { status: 404 }));

		await expect(new PocketChestAPI('').retrieveChest('ABC123')).rejects.toThrow('Retrieval code not found or expired');
	});
});

describe('reading the code from the page fragment', () => {
	it('reads a valid code from the fragment', () => {
		expect(parseCodeFromHash('#ABC123')).toBe('ABC123');
		expect(parseCodeFromHash('#abc123')).toBe('ABC123');
	});

	it('ignores the old ?code= form: only the fragment is read', () => {
		expect(parseCodeFromHash('')).toBeNull();
	});

	it('does not throw on malformed percent-encoding', () => {
		expect(() => parseCodeFromHash('#%ZZ')).not.toThrow();
		expect(parseCodeFromHash('#%ZZ')).toBeNull();
		expect(parseCodeFromHash('#%E4%')).toBeNull();
	});

	it('rejects codes of the wrong length or characters', () => {
		expect(parseCodeFromHash('#ABC12')).toBeNull();
		expect(parseCodeFromHash('#ABC1234')).toBeNull();
		expect(parseCodeFromHash('#ABC12!')).toBeNull();
		expect(normalizeRetrievalCode('  xyz789 ')).toBe('XYZ789');
	});
});
