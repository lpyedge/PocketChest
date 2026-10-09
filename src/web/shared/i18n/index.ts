import type enMessages from './locales/en.json';

// Interface language. Only the three listed locales exist; anything else falls back to the default.
export const LOCALES = ['zh-Hant', 'ja', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'zh-Hant';
export const LOCALE_STORAGE_KEY = 'pocketchest.locale';

export function isLocale(value: unknown): value is Locale {
	return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

// Maps a browser language tag to one of the supported locales, or null when none fits
export function mapBrowserLanguage(tag: string): Locale | null {
	const lower = tag.toLowerCase();
	if (lower === 'zh-tw' || lower === 'zh-hk' || lower === 'zh-hant' || lower.startsWith('zh-hant-')) return 'zh-Hant';
	if (lower === 'ja' || lower.startsWith('ja-')) return 'ja';
	if (lower === 'en' || lower.startsWith('en-')) return 'en';
	return null;
}

/** Stored choice first, then the browser's languages in order, then the default. Never trusts stored values blindly. */
export function resolveLocale(stored: unknown, languages: readonly string[]): Locale {
	if (isLocale(stored)) return stored;
	for (const tag of languages) {
		const mapped = mapBrowserLanguage(tag);
		if (mapped) return mapped;
	}
	return DEFAULT_LOCALE;
}

// Each locale is its own chunk: a visitor downloads only the language they use
export const loaders: Record<Locale, () => Promise<{ default: Messages }>> = {
	'zh-Hant': () => import('./locales/zh-Hant.json'),
	ja: () => import('./locales/ja.json'),
	en: () => import('./locales/en.json'),
};

export type Messages = Record<string, string>;

// Keys are checked against the English file; the other locales must have the same keys (see the key test)
export type MessageKey = keyof typeof enMessages;
