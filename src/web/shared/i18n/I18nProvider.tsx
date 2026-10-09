import { createContext, ReactNode, useCallback, useRef, useContext, useEffect, useMemo, useState } from 'react';
import {
	DEFAULT_LOCALE,
	isLocale,
	loaders,
	LOCALE_STORAGE_KEY,
	localeFromSearch,
	Locale,
	MessageKey,
	Messages,
	resolveLocale,
	withLocaleParam,
} from './index';

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
		// A link from a static home page names its language (?lang=ja). Following it is a choice, so it is remembered.
		const requested = localeFromSearch(window.location.search);
		const chosen = resolveLocale(readStoredLocale(), languages, requested);
		if (requested) writeStoredLocale(requested);
		return chosen;
	});
	// The messages for the last locale that finished loading; the old ones stay on screen until the new ones arrive
	const [loaded, setLoaded] = useState<{ locale: Locale; messages: Messages } | null>(null);

	// The language whose messages could not be downloaded, if the last attempt failed
	const [failedLocale, setFailedLocale] = useState<Locale | null>(null);

	// A language the visitor asked for, not yet kept: it is remembered (and put in the address) only once its
	// messages have really arrived, so a failed download leaves nothing behind that would ask for it again
	const asked = useRef<Locale | null>(null);

	useEffect(() => {
		let cancelled = false;
		loaders[locale]()
			.then((module) => {
				if (cancelled) return;
				setFailedLocale(null);
				setLoaded({ locale, messages: module.default });
				if (asked.current === locale) {
					asked.current = null;
					writeStoredLocale(locale);
					// Keep a ?lang= in the address in step, so a reload does not bring the old language back (the #fragment is untouched)
					const search = withLocaleParam(window.location.search, locale);
					if (search !== window.location.search) {
						window.history.replaceState(window.history.state, '', `${window.location.pathname}${search}${window.location.hash}`);
					}
				}
			})
			.catch((error: unknown) => {
				if (cancelled) return;
				console.error('Could not load the language file:', error);
				asked.current = null;
				if (loaded) {
					// A language switch failed: stay in the language that is on screen, in step with the page's lang
					setLocaleState(loaded.locale);
				} else {
					setFailedLocale(locale);
				}
			});
		return () => {
			cancelled = true;
		};
		// `loaded` is only read to decide how to recover, it must not restart the download
	}, [locale]);

	// The page's language follows the text on screen, which changes only when the new messages are there
	const shownLocale = loaded?.locale;
	useEffect(() => {
		if (shownLocale) document.documentElement.lang = HTML_LANG[shownLocale];
	}, [shownLocale]);

	const setLocale = useCallback((next: Locale) => {
		if (!isLocale(next)) return;
		asked.current = next;
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

	// Nothing is shown until the first language arrives, so no text appears in the wrong language.
	// If it cannot arrive, say so (the texts are fixed here because the messages are exactly what is missing).
	if (!loaded) return failedLocale ? <LoadFailure locale={failedLocale} /> : null;
	return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
	const value = useContext(I18nContext);
	if (!value) {
		throw new Error('useI18n must be used inside I18nProvider');
	}
	return value;
}

// Shown only when the first language file cannot be downloaded. It cannot use the message files, so it speaks all three.
function LoadFailure({ locale }: { locale: Locale }) {
	const useEnglish = () => {
		writeStoredLocale('en');
		// ?lang= would ask for the failed language again
		window.location.assign(`${window.location.pathname}${window.location.hash}`);
	};
	return (
		<main role="alert" className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
			<div className="max-w-md w-full bg-white rounded-lg shadow-md p-6 text-center space-y-3">
				<p className="text-gray-900">Could not load the page text. Check your connection and try again.</p>
				<p className="text-gray-600 text-sm">頁面文字載入失敗，請檢查網路後重試。</p>
				<p className="text-gray-600 text-sm">ページの文言を読み込めませんでした。接続を確認して、もう一度お試しください。</p>
				<div className="flex flex-wrap justify-center gap-2 pt-2">
					<button type="button" onClick={() => window.location.reload()} className="px-4 py-2 bg-blue-500 text-white rounded">
						Retry / 重試 / 再試行
					</button>
					{locale !== 'en' && (
						<button type="button" onClick={useEnglish} className="px-4 py-2 border border-gray-300 rounded text-gray-700">
							English
						</button>
					)}
				</div>
			</div>
		</main>
	);
}
