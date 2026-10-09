import { describe, it, expect } from 'vitest';
import en from '../src/web/shared/i18n/locales/en.json';
import ja from '../src/web/shared/i18n/locales/ja.json';
import zh from '../src/web/shared/i18n/locales/zh-Hant.json';
import { DEFAULT_LOCALE, mapBrowserLanguage, resolveLocale } from '../src/web/shared/i18n';

const locales: Record<string, Record<string, string>> = { en, ja, 'zh-Hant': zh };

// The placeholders a message uses, e.g. {name}, as a sorted list
function placeholders(text: string): string[] {
	return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

describe('translation files', () => {
	it('have exactly the same keys in every language', () => {
		const expected = Object.keys(en).sort();
		for (const [name, messages] of Object.entries(locales)) {
			expect(Object.keys(messages).sort(), name).toEqual(expected);
		}
	});

	it('use the same placeholders in every language', () => {
		for (const key of Object.keys(en)) {
			const expected = placeholders(en[key as keyof typeof en]);
			for (const [name, messages] of Object.entries(locales)) {
				expect(placeholders(messages[key]), `${name}:${key}`).toEqual(expected);
			}
		}
	});

	it('have no empty messages', () => {
		for (const [name, messages] of Object.entries(locales)) {
			for (const [key, text] of Object.entries(messages)) {
				expect(text.trim(), `${name}:${key}`).not.toBe('');
			}
		}
	});
});

describe('language choice', () => {
	it('uses a stored choice when it is a supported locale', () => {
		expect(resolveLocale('ja', ['en-US'])).toBe('ja');
	});

	it('ignores a stored value that is not a supported locale', () => {
		expect(resolveLocale('fr', ['en-US'])).toBe('en');
		expect(resolveLocale('<script>', ['ja-JP'])).toBe('ja');
		expect(resolveLocale(42, [])).toBe(DEFAULT_LOCALE);
	});

	it('maps regional browser tags to the supported locales', () => {
		expect(mapBrowserLanguage('zh-TW')).toBe('zh-Hant');
		expect(mapBrowserLanguage('zh-HK')).toBe('zh-Hant');
		expect(mapBrowserLanguage('ja-JP')).toBe('ja');
		expect(mapBrowserLanguage('en-GB')).toBe('en');
	});

	it('takes the first browser language it supports, and falls back to the default', () => {
		expect(resolveLocale(null, ['fr-FR', 'ja-JP', 'en-US'])).toBe('ja');
		expect(resolveLocale(null, ['fr-FR', 'de'])).toBe(DEFAULT_LOCALE);
		expect(resolveLocale(null, [])).toBe('zh-Hant');
	});

	it('does not treat simplified Chinese as traditional', () => {
		expect(mapBrowserLanguage('zh-CN')).toBeNull();
	});
});
