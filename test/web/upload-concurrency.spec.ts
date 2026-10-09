import { describe, it, expect, vi, afterEach } from 'vitest';
import { PocketChestAPI } from '../../src/web/shared/lib/api';
import type { FileUploadProgress } from '../../src/web/shared/lib/types';

// Replaces the network request for one small file or one batch of text items.
// Tracks how many requests are in flight at the same time.
function mockRequests(options: { failOnCall?: number; delay?: (call: number) => number } = {}) {
	const state = { active: 0, maxActive: 0, started: 0, activeAtReject: -1 };
	let fileCounter = 0;

	const spy = vi.spyOn(PocketChestAPI.prototype as any, 'uploadContentRegular').mockImplementation(async (...args: unknown[]) => {
		const [, , files, textItems] = args as [string, string, File[], { content: string; filename?: string }[]];
		const call = state.started++;
		state.active++;
		state.maxActive = Math.max(state.maxActive, state.active);
		try {
			await new Promise((resolve) => setTimeout(resolve, options.delay ? options.delay(call) : 2));
			if (options.failOnCall === call) {
				throw new Error('simulated network failure');
			}
			if (files.length === 1) {
				fileCounter++;
				return { uploadedFiles: [{ fileId: `file-id-${fileCounter}`, filename: files[0].name, isText: false }] };
			}
			return {
				uploadedFiles: textItems.map((item, i) => ({
					fileId: `text-id-${call}-${i}`,
					filename: item.filename ?? `text-${i}.txt`,
					isText: true,
				})),
			};
		} catch (error) {
			state.activeAtReject = state.active - 1;
			throw error;
		} finally {
			state.active--;
		}
	});

	return { spy, state };
}

function smallFiles(count: number, prefix = 'file') {
	return Array.from({ length: count }, (_, i) => new File([`content ${i}`], `${prefix}-${i}.txt`, { type: 'text/plain' }));
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('small file concurrent upload', () => {
	for (const count of [1, 3, 5, 20]) {
		it(`uploads ${count} small files, runs at most 3 at once, and returns only after all finish`, async () => {
			const { state } = mockRequests({ delay: (call) => 2 + (call % 4) * 3 });
			const api = new PocketChestAPI('');
			const files = smallFiles(count);

			const result = await api.uploadContent('session', 'token', files, []);

			expect(state.active).toBe(0);
			expect(state.maxActive).toBe(Math.min(3, count));
			expect(result.uploadedFiles).toHaveLength(count);
			expect(result.uploadedFiles.every((f) => f.fileId.startsWith('file-id-'))).toBe(true);
			expect(new Set(result.uploadedFiles.map((f) => f.fileId)).size).toBe(count);
		});
	}

	it('returns fileIds in input order even when requests finish out of order', async () => {
		mockRequests({ delay: (call) => (call === 0 ? 30 : 1) });
		const api = new PocketChestAPI('');
		const files = smallFiles(3);

		const result = await api.uploadContent('session', 'token', files, []);

		expect(result.uploadedFiles.map((f) => f.filename)).toEqual(files.map((f) => f.name));
	});

	it('rejects after in-flight requests settle and starts no new request after a failure', async () => {
		const { state } = mockRequests({ failOnCall: 3, delay: () => 5 });
		const api = new PocketChestAPI('');

		await expect(api.uploadContent('session', 'token', smallFiles(20), [])).rejects.toThrow('simulated network failure');

		expect(state.active).toBe(0);
		expect(state.started).toBeLessThan(20);
		expect(state.started).toBeLessThanOrEqual(3 + 3);
	});

	it('keeps same-name files and same-name text items as separate entries', async () => {
		mockRequests();
		const api = new PocketChestAPI('');
		const files = [new File(['first'], 'a.txt', { type: 'text/plain' }), new File(['second'], 'a.txt', { type: 'text/plain' })];
		const textItems = [
			{ content: 'one', filename: 'note.txt' },
			{ content: 'two', filename: 'note.txt' },
		];
		let lastProgress: FileUploadProgress[] = [];

		const result = await api.uploadContent('session', 'token', files, textItems, undefined, (list) => {
			lastProgress = list;
		});

		expect(result.uploadedFiles).toHaveLength(4);
		expect(new Set(result.uploadedFiles.map((f) => f.fileId)).size).toBe(4);
		expect(lastProgress.map((p) => p.localId)).toEqual(['file-0', 'file-1', 'text-0', 'text-1']);
		expect(lastProgress.every((p) => p.status === 'completed')).toBe(true);
	});

	it('handles an empty file as a normal upload', async () => {
		mockRequests();
		const api = new PocketChestAPI('');

		const result = await api.uploadContent('session', 'token', [new File([], 'empty.txt', { type: 'text/plain' })], []);

		expect(result.uploadedFiles).toHaveLength(1);
		expect(result.uploadedFiles[0].fileId).toMatch(/^file-id-/);
	});
});
