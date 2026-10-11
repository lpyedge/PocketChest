import { normalizeRetrievalCode } from './share';

// A record of the shares made from this browser. It lives only in this browser's storage (the server keeps no
// list of shares) and holds what is needed to open or copy a share again.
export interface HistoryEntry {
	code: string;
	createdAt: number;
	// Milliseconds since the epoch, or null for a permanent share
	expiresAt: number | null;
	files: number;
	texts: number;
}

export type HistoryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const HISTORY_KEY = 'pocketchest.shareHistory';
export const HISTORY_LIMIT = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

function defaultStorage(): HistoryStorage | null {
	try {
		return typeof window === 'undefined' ? null : window.localStorage;
	} catch {
		return null;
	}
}

export function expiryFromDays(validityDays: number, now: number): number | null {
	return validityDays < 0 ? null : now + validityDays * DAY_MS;
}

function parse(raw: string | null): HistoryEntry[] {
	if (!raw) return [];
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(value)) return [];
	const entries: HistoryEntry[] = [];
	for (const item of value) {
		if (typeof item !== 'object' || item === null) continue;
		const { code, createdAt, expiresAt, files, texts } = item as Record<string, unknown>;
		const normalized = typeof code === 'string' ? normalizeRetrievalCode(code) : null;
		if (!normalized || typeof createdAt !== 'number' || !Number.isFinite(createdAt)) continue;
		if (expiresAt !== null && (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt))) continue;
		entries.push({
			code: normalized,
			createdAt,
			expiresAt,
			files: typeof files === 'number' && files > 0 ? Math.floor(files) : 0,
			texts: typeof texts === 'number' && texts > 0 ? Math.floor(texts) : 0,
		});
	}
	return entries;
}

function write(entries: HistoryEntry[], storage: HistoryStorage | null): void {
	if (!storage) return;
	try {
		if (entries.length === 0) storage.removeItem(HISTORY_KEY);
		else storage.setItem(HISTORY_KEY, JSON.stringify(entries));
	} catch {
		// Storage can be full or blocked; the history is a convenience and never blocks a share
	}
}

/** The saved shares, newest first. Shares that have expired are gone from the server too, so they are dropped. */
export function loadHistory(now: number = Date.now(), storage: HistoryStorage | null = defaultStorage()): HistoryEntry[] {
	if (!storage) return [];
	let all: HistoryEntry[];
	try {
		all = parse(storage.getItem(HISTORY_KEY));
	} catch {
		return [];
	}
	const live = all.filter((entry) => entry.expiresAt === null || entry.expiresAt > now).sort((a, b) => b.createdAt - a.createdAt);
	if (live.length !== all.length) write(live, storage);
	return live;
}

export function addHistory(
	entry: HistoryEntry,
	now: number = Date.now(),
	storage: HistoryStorage | null = defaultStorage(),
): HistoryEntry[] {
	const next = [entry, ...loadHistory(now, storage).filter((existing) => existing.code !== entry.code)].slice(0, HISTORY_LIMIT);
	write(next, storage);
	return next;
}

export function removeHistory(code: string, now: number = Date.now(), storage: HistoryStorage | null = defaultStorage()): HistoryEntry[] {
	const next = loadHistory(now, storage).filter((entry) => entry.code !== code);
	write(next, storage);
	return next;
}

export function clearHistory(storage: HistoryStorage | null = defaultStorage()): void {
	write([], storage);
}
