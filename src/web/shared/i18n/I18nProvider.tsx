import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { DEFAULT_LOCALE, isLocale, loaders, LOCALE_STORAGE_KEY, Locale, MessageKey, Messages, resolveLocale } from './index';

export type { MessageKey };

type Params = Record<string, string | number>;

interface I18nValue {
	locale: Locale;
	t: (key: MessageKey, params?: Params) => string;
	setLocale: (next: Locale) => void;
}

const HTML_LANG: Record<Locale, string> = { 'zh-Hant': 'zh-Hant', ja: 'ja', en: 'en' };

const I18nContext = createContext<I18nValue | null>(null);

// Storage can be unavailable (private windows, blocked storage); the choice then only lasts for the page
function readStoredLocale(): unknown {
	try {
		return window.localStorage.getItem(LOCALE_STORAGE_KEY);
	} catch {
		return null;
	}
}

function writeStoredLocale(locale: Locale): void {
	try {
		window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
	} catch {
		// Keep going with the in-memory choice
	}
}

export function I18nProvider({ children }: { children: ReactNode }) {
	const [locale, setLocaleState] = useState<Locale>(() => {
		const languages = navigator.languages?.length ? navigator.languages : [navigator.language ?? DEFAULT_LOCALE];
		return resolveLocale(readStoredLocale(), languages);
	});
	// The messages for the last locale that finished loading; the old ones stay on screen until the new ones arrive
	const [loaded, setLoaded] = useState<{ locale: Locale; messages: Messages } | null>(null);

	useEffect(() => {
		let cancelled = false;
		loaders[locale]().then((module) => {
			if (!cancelled) setLoaded({ locale, messages: module.default });
		});
		return () => {
			cancelled = true;
		};
	}, [locale]);

	useEffect(() => {
		document.documentElement.lang = HTML_LANG[locale];
	}, [locale]);

	const setLocale = useCallback((next: Locale) => {
		if (!isLocale(next)) return;
		writeStoredLocale(next);
		setLocaleState(next);
	}, []);

	const messages = loaded?.messages;
	const t = useCallback(
		(key: MessageKey, params?: Params) => {
			const template = messages?.[key];
			if (template === undefined) {
				if (import.meta.env.DEV) console.warn(`Missing translation: ${key}`);
				return key;
			}
			return template.replace(/\{(\w+)\}/g, (match, name: string) => (params && name in params ? String(params[name]) : match));
		},
		[messages],
	);

	const value = useMemo(() => ({ locale, t, setLocale }), [locale, t, setLocale]);

	// Nothing is shown until the first language arrives, so no text appears in the wrong language
	if (!loaded) return null;
	return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
	const value = useContext(I18nContext);
	if (!value) {
		throw new Error('useI18n must be used inside I18nProvider');
	}
	return value;
}
