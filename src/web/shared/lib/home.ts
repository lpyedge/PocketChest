import { Locale } from '../i18n';

// The static home page of each language. The home pages have no script, so they cannot remember a choice:
// the way back has to name the right one.
const HOME: Record<Locale, string> = { 'zh-Hant': '/', ja: '/ja/', en: '/en/' };

export function homeUrlFor(locale: Locale): string {
	return HOME[locale];
}

/** A link from one app page to another that carries the current language (not for share links: those stay /retrieve/#CODE). */
export function appUrl(path: '/upload/' | '/retrieve/', locale: Locale): string {
	return `${path}?lang=${locale}`;
}
