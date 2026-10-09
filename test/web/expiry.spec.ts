import { describe, it, expect } from 'vitest';
import { describeExpiry } from '../../src/web/shared/lib/expiry';
import en from '../../src/web/shared/i18n/locales/en.json';
import ja from '../../src/web/shared/i18n/locales/ja.json';
import zhHant from '../../src/web/shared/i18n/locales/zh-Hant.json';

type Messages = Record<string, string>;
const translator = (messages: Messages) => (key: string, params?: Record<string, string | number>) =>
	(messages[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''));

describe('FIX-09 permanent chests show no date', () => {
	const cases: [string, string, Messages, RegExp][] = [
		['en', 'en', en, /never|permanent/i],
		['ja', 'ja', ja, /無期限/],
		['zh-Hant', 'zh-TW', zhHant, /永久/],
	];
	for (const [name, locale, messages, pattern] of cases) {
		it(`${name}: null reads as permanent, never 1970 or Invalid Date`, () => {
			const text = describeExpiry(null, locale, translator(messages) as never);
			expect(text).toMatch(pattern);
			expect(text).not.toMatch(/1970|Invalid/);
		});

		it(`${name}: a real expiry is formatted as a date`, () => {
			const text = describeExpiry('2030-05-06T07:08:09.000Z', locale, translator(messages) as never);
			expect(text).toContain('2030');
			expect(text).not.toMatch(pattern);
		});
	}

	it('does not claim a chest is permanent when the date cannot be read', () => {
		const text = describeExpiry('not-a-date', 'en', translator(en) as never);
		expect(text).not.toMatch(/permanent/i);
	});
});
