import { describe, it, expect, vi, afterEach } from 'vitest';
import { PocketChestAPI } from '../../src/web/shared/lib/api';
import { ClientError } from '../../src/web/shared/lib/errors';
import { AUTO_LOAD_TEXT_ITEMS, loadTexts, TEXT_LOAD_CONCURRENCY, TextState } from '../../src/web/shared/lib/text-loader';

afterEach(() => vi.restoreAllMocks());

const ids = (count: number) => Array.from({ length: count }, (_, i) => `id-${i}`);

// A server that allows `limit` authorizations and then answers 429
function limited(limit: number) {
	const state = { calls: 0, active: 0, peak: 0 };
	const load = async (id: string) => {
		const nth = ++state.calls;
		state.active++;
		state.peak = Math.max(state.peak, state.active);
		await new Promise((resolve) => setTimeout(resolve, 2));
		state.active--;
		if (nth > limit) throw new ClientError('error.downloadText', 'RATE_LIMITED');
		return `text of ${id}`;
	};
	return { state, load };
}

async function run(count: number, limit: number) {
	const { state, load } = limited(limit);
	const states = new Map<string, TextState>();
	await loadTexts(ids(count), load, new AbortController().signal, (id, next) => states.set(id, next));
	return { state, states };
}

describe('N2-02 text items load a few at a time, and one refusal is only that item', () => {
	for (const count of [0, 1, 30, 31, 50, 100]) {
		it(`T05/T06: ${count} items — at most ${TEXT_LOAD_CONCURRENCY} at once, every item ends loaded or failed`, async () => {
			const { state, states } = await run(count, 30);

			expect(state.peak).toBeLessThanOrEqual(TEXT_LOAD_CONCURRENCY);
			expect(states.size).toBe(count);
			const loaded = [...states.values()].filter((s) => s.status === 'loaded').length;
			const failed = [...states.values()].filter((s) => s.status === 'error');
			expect(loaded).toBe(Math.min(count, 30));
			expect(failed).toHaveLength(Math.max(0, count - 30));
			for (const item of failed) expect(item.code).toBe('RATE_LIMITED');
		});
	}

	it('T05: items that failed can be loaded again on their own', async () => {
		const { states } = await run(35, 30);
		const failedIds = [...states.entries()].filter(([, s]) => s.status === 'error').map(([id]) => id);
		expect(failedIds).toHaveLength(5);

		const again = new Map(states);
		await loadTexts(
			failedIds,
			async (id) => `text of ${id}`,
			new AbortController().signal,
			(id, next) => again.set(id, next),
		);

		expect([...again.values()].every((s) => s.status === 'loaded')).toBe(true);
	});

	it('only the first items are loaded without being asked', () => {
		expect(AUTO_LOAD_TEXT_ITEMS).toBeLessThanOrEqual(10);
		expect(AUTO_LOAD_TEXT_ITEMS).toBeGreaterThan(0);
	});

	it('T15: stops starting requests once cancelled, and reports no failures for the cancelled ones', async () => {
		const controller = new AbortController();
		const calls: string[] = [];
		const updates: TextState['status'][] = [];
		const load = async (id: string, signal: AbortSignal) => {
			calls.push(id);
			await new Promise((resolve) => setTimeout(resolve, 5));
			signal.throwIfAborted();
			return id;
		};

		const running = loadTexts(ids(50), load, controller.signal, (_, next) => updates.push(next.status));
		setTimeout(() => controller.abort(), 8);
		await running;

		expect(calls.length).toBeLessThan(15);
		expect(updates).not.toContain('error');
	});
});

describe('N2-06 the authorization request carries the cancellation signal too', () => {
	it('passes the signal to both the authorize POST and the file GET, and stops between them', async () => {
		const seen: { url: string; signal?: AbortSignal | null }[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init?: RequestInit) => {
				seen.push({ url, signal: init?.signal });
				return new Response(url.includes('authorize') ? '{}' : 'hello', { status: 200 });
			}),
		);
		const controller = new AbortController();

		await expect(new PocketChestAPI('').downloadTextContent('file-1', 'token', controller.signal)).resolves.toBe('hello');
		expect(seen).toHaveLength(2);
		expect(seen[0].url).toContain('/api/download/authorize');
		expect(seen[0].signal).toBe(controller.signal);
		expect(seen[1].signal).toBe(controller.signal);
	});

	it('a signal that is already aborted sends nothing', async () => {
		const fetchSpy = vi.fn(async () => new Response('{}'));
		vi.stubGlobal('fetch', fetchSpy);
		const controller = new AbortController();
		controller.abort();

		await expect(new PocketChestAPI('').downloadTextContent('file-1', 'token', controller.signal)).rejects.toMatchObject({
			name: 'AbortError',
		});
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('an abort between authorizing and reading stops before the read', async () => {
		const controller = new AbortController();
		const fetchSpy = vi.fn(async (url: string) => {
			if (url.includes('authorize')) controller.abort();
			return new Response('{}');
		});
		vi.stubGlobal('fetch', fetchSpy);

		await expect(new PocketChestAPI('').downloadTextContent('file-1', 'token', controller.signal)).rejects.toMatchObject({
			name: 'AbortError',
		});
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});
});
