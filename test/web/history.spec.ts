import { describe, it, expect } from 'vitest';
import {
	addHistory,
	clearHistory,
	expiryFromDays,
	HISTORY_KEY,
	HISTORY_LIMIT,
	loadHistory,
	removeHistory,
} from '../../src/web/shared/lib/history';

function memoryStorage(initial?: string) {
	const data = new Map<string, string>();
	if (initial !== undefined) data.set(HISTORY_KEY, initial);
	return {
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => void data.set(key, value),
		removeItem: (key: string) => void data.delete(key),
	};
}

const DAY = 24 * 60 * 60 * 1000;
const entry = (code: string, createdAt: number, expiresAt: number | null = null) => ({ code, createdAt, expiresAt, files: 1, texts: 0 });

describe('share history', () => {
	it('keeps the newest share first and replaces a repeated code', () => {
		const storage = memoryStorage();
		addHistory(entry('AAAAAA', 1), 10, storage);
		addHistory(entry('BBBBBB', 2), 10, storage);
		addHistory(entry('AAAAAA', 3), 10, storage);
		expect(loadHistory(10, storage).map((item) => item.code)).toEqual(['AAAAAA', 'BBBBBB']);
	});

	it('drops expired shares but keeps permanent ones', () => {
		const storage = memoryStorage();
		addHistory(entry('AAAAAA', 1, 50), 10, storage);
		addHistory(entry('BBBBBB', 2, null), 10, storage);
		expect(loadHistory(100, storage).map((item) => item.code)).toEqual(['BBBBBB']);
	});

	it('removes one share and clears all', () => {
		const storage = memoryStorage();
		addHistory(entry('AAAAAA', 1), 10, storage);
		addHistory(entry('BBBBBB', 2), 10, storage);
		expect(removeHistory('AAAAAA', 10, storage).map((item) => item.code)).toEqual(['BBBBBB']);
		clearHistory(storage);
		expect(loadHistory(10, storage)).toEqual([]);
	});

	it('limits the number of saved shares', () => {
		const storage = memoryStorage();
		for (let i = 0; i < HISTORY_LIMIT + 5; i++) addHistory(entry(`A${String(i).padStart(5, '0')}`, i), 0, storage);
		expect(loadHistory(0, storage)).toHaveLength(HISTORY_LIMIT);
	});

	it('ignores damaged or foreign data', () => {
		expect(loadHistory(0, memoryStorage('not json'))).toEqual([]);
		expect(loadHistory(0, memoryStorage('{"a":1}'))).toEqual([]);
		expect(loadHistory(0, memoryStorage(JSON.stringify([{ code: '<script>', createdAt: 1, expiresAt: null }, null, 5])))).toEqual([]);
	});

	it('works without any storage', () => {
		expect(loadHistory(0, null)).toEqual([]);
		expect(addHistory(entry('AAAAAA', 1), 0, null)).toHaveLength(1);
	});

	it('computes the expiry from the validity: permanent has none', () => {
		expect(expiryFromDays(-1, 5)).toBeNull();
		expect(expiryFromDays(7, 5)).toBe(5 + 7 * DAY);
	});
});
