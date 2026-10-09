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

/**
 * The language a link asks for, from a URL search string such as `?lang=ja`. Only an exact, single value of
 * one of the supported locales counts; anything else is ignored rather than guessed at.
 */
export function localeFromSearch(search: string): Locale | null {
	const values = new URLSearchParams(search).getAll('lang');
	return values.length === 1 && isLocale(values[0]) ? values[0] : null;
}

/** The same search string with its `lang` value replaced; a search without `lang` is returned unchanged. */
export function withLocaleParam(search: string, locale: Locale): string {
	const params = new URLSearchParams(search);
	if (!params.has('lang')) return search;
	params.set('lang', locale);
	return `?${params.toString()}`;
}

/** A language asked for by the link, then the stored choice, then the browser's languages in order, then the default. */
export function resolveLocale(stored: unknown, languages: readonly string[], requested: Locale | null = null): Locale {
	if (requested) return requested;
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
