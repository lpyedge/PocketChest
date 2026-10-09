import { describe, it, expect } from 'vitest';
import { appUrl, homeUrlFor } from '../../src/web/shared/lib/home';
import { LOCALES } from '../../src/web/shared/i18n';

describe('N2-05 the way back home keeps the language', () => {
	it('maps each language to its own static home page', () => {
		expect(homeUrlFor('zh-Hant')).toBe('/');
		expect(homeUrlFor('ja')).toBe('/ja/');
		expect(homeUrlFor('en')).toBe('/en/');
	});

	it('has a home page for every supported language', () => {
		for (const locale of LOCALES) expect(homeUrlFor(locale)).toMatch(/^\/(ja\/|en\/)?$/);
	});

	it('links between the apps carry the language, and never touch a share fragment', () => {
		expect(appUrl('/upload/', 'ja')).toBe('/upload/?lang=ja');
		expect(appUrl('/retrieve/', 'zh-Hant')).toBe('/retrieve/?lang=zh-Hant');
		expect(appUrl('/retrieve/', 'en')).not.toContain('#');
	});
});
