import { describe, it, expect, vi, afterEach } from 'vitest';
import { PocketChestAPI } from '../../src/web/shared/lib/api';
import { MAX_MULTIPART_FILE_BYTES, MAX_PARTS, PART_BYTES, planParts } from '../../src/web/shared/lib/multipart';

afterEach(() => vi.restoreAllMocks());

describe('FIX-10 multipart planning', () => {
	it('splits the largest accepted file into exactly the part limit', () => {
		expect(planParts(MAX_MULTIPART_FILE_BYTES)).toEqual({ partBytes: PART_BYTES, totalParts: MAX_PARTS });
	});

	it('refuses the first byte that would need one part more', () => {
		expect(planParts(MAX_MULTIPART_FILE_BYTES + 1)).toBeNull();
		expect(Math.ceil((MAX_MULTIPART_FILE_BYTES + 1) / PART_BYTES)).toBe(MAX_PARTS + 1);
	});

	it('counts a partial last part', () => {
		expect(planParts(PART_BYTES * 3 + 1)).toEqual({ partBytes: PART_BYTES, totalParts: 4 });
		expect(planParts(1)).toEqual({ partBytes: PART_BYTES, totalParts: 1 });
	});

	it('every accepted size completes within the part limit', () => {
		for (const size of [1, PART_BYTES, PART_BYTES + 1, MAX_MULTIPART_FILE_BYTES - 1, MAX_MULTIPART_FILE_BYTES]) {
			expect(planParts(size)!.totalParts).toBeLessThanOrEqual(MAX_PARTS);
		}
	});

	it('uploadLargeFile refuses an over-limit file before contacting the server', async () => {
		const create = vi.spyOn(PocketChestAPI.prototype, 'createMultipartUpload');
		const huge = { name: 'huge.bin', size: MAX_MULTIPART_FILE_BYTES + 1, type: 'application/octet-stream' } as File;

		const failure = await new PocketChestAPI('').uploadLargeFile('s', 't', huge).catch((error: Error) => error);

		expect((failure as Error).message).toBe('error.fileTooLargeMax');
		expect(create).not.toHaveBeenCalled();
	});

	it('uploadContent refuses before uploading anything when any file is over the limit', async () => {
		const regular = vi.spyOn(PocketChestAPI.prototype as any, 'uploadContentRegular');
		const huge = { name: 'huge.bin', size: MAX_MULTIPART_FILE_BYTES + 1, type: '' } as File;
		const small = new File(['x'], 'small.txt');

		const failure = await new PocketChestAPI('').uploadContent('s', 't', [small, huge], []).catch((error: Error) => error);

		expect((failure as Error).message).toBe('error.fileTooLargeMax');
		expect(regular).not.toHaveBeenCalled();
	});
});
