import { describe, it, expect } from 'vitest';
import { DEFAULT_LOCALE, localeFromSearch, resolveLocale, withLocaleParam } from '../../src/web/shared/i18n';

describe('R07 ?lang= carries the home page language into the app', () => {
	it('accepts only the three supported values', () => {
		expect(localeFromSearch('?lang=ja')).toBe('ja');
		expect(localeFromSearch('?lang=en')).toBe('en');
		expect(localeFromSearch('?lang=zh-Hant')).toBe('zh-Hant');
		expect(localeFromSearch('?x=1&lang=ja')).toBe('ja');
	});

	it('ignores everything else instead of guessing', () => {
		for (const search of [
			'',
			'?',
			'?lang=',
			'?lang=fr',
			'?lang=JA',
			'?lang=ja%00',
			'?lang=<script>',
			'?lang=ja&lang=en',
			'?language=ja',
			'?lang[]=ja',
		]) {
			expect(localeFromSearch(search), search).toBeNull();
		}
	});

	it('beats the stored choice and the browser languages', () => {
		expect(resolveLocale('en', ['en-US'], 'ja')).toBe('ja');
		expect(resolveLocale(null, ['en-US'], 'zh-Hant')).toBe('zh-Hant');
	});

	it('falls back to the old order when there is no parameter', () => {
		expect(resolveLocale('ja', ['en-US'], null)).toBe('ja');
		expect(resolveLocale(null, ['en-US'])).toBe('en');
		expect(resolveLocale(null, [])).toBe(DEFAULT_LOCALE);
	});

	it('rewrites only the lang parameter of a URL search, and leaves the hash to the caller', () => {
		expect(withLocaleParam('?lang=ja', 'en')).toBe('?lang=en');
		expect(withLocaleParam('?a=1&lang=ja', 'en')).toBe('?a=1&lang=en');
		expect(withLocaleParam('?a=1', 'en')).toBe('?a=1');
		expect(withLocaleParam('', 'en')).toBe('');
	});
});
