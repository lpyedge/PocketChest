import { describe, it, expect } from 'vitest';
import { formatBytes } from '../../src/web/shared/lib/format';
import { MAX_MULTIPART_FILE_BYTES } from '../../src/web/shared/lib/multipart';

const labels = { zero: '0 Bytes', bytes: 'Bytes' };

describe('C23 file sizes use binary units with binary names', () => {
	it('shows 1024 bytes as 1 KiB, not 1 KB', () => {
		expect(formatBytes(1024, 'en', labels)).toBe('1 KiB');
		expect(formatBytes(1536, 'en', labels)).toBe('1.5 KiB');
	});

	it('walks up the units at each factor of 1024', () => {
		expect(formatBytes(1, 'en', labels)).toBe('1 Bytes');
		expect(formatBytes(1023, 'en', labels)).toBe('1,023 Bytes');
		expect(formatBytes(1024 ** 2, 'en', labels)).toBe('1 MiB');
		expect(formatBytes(1024 ** 3, 'en', labels)).toBe('1 GiB');
		expect(formatBytes(1024 ** 4, 'en', labels)).toBe('1 TiB');
	});

	it('shows the upload limit as 195.31 GiB', () => {
		expect(formatBytes(MAX_MULTIPART_FILE_BYTES, 'en', labels)).toBe('195.31 GiB');
	});

	it('shows zero with its own label, and never produces NaN or undefined', () => {
		expect(formatBytes(0, 'en', labels)).toBe('0 Bytes');
		for (const value of [0, 1, 999, 1e15, 1e20]) {
			expect(formatBytes(value, 'en', labels)).not.toMatch(/NaN|undefined/);
		}
	});

	it('formats the number for the locale', () => {
		expect(formatBytes(1.5 * 1024, 'de', labels)).toBe('1,5 KiB');
	});
});
