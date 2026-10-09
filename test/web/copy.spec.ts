import { describe, it, expect } from 'vitest';
import en from '../../src/web/shared/i18n/locales/en.json';
import ja from '../../src/web/shared/i18n/locales/ja.json';
import zhHant from '../../src/web/shared/i18n/locales/zh-Hant.json';

const locales = { en, ja, 'zh-Hant': zhHant } as Record<string, Record<string, string>>;

describe('wording that must match what the service does', () => {
	it('one day means 24 hours, not "tomorrow"', () => {
		expect(en['expiry.1d.desc']).toBe('Expires in 24 hours');
		expect(ja['expiry.1d.desc']).toBe('24時間後に期限切れ');
		expect(zhHant['expiry.1d.desc']).toBe('24 小時後到期');
	});

	it('the largest file is stated in GiB, as 20 MiB x 10,000 parts really is', () => {
		for (const [name, messages] of Object.entries(locales)) {
			expect(messages['error.fileTooLargeMax'], name).toMatch(/195\.3 GiB/);
			expect(messages['error.fileTooLargeMax'], name).not.toMatch(/195 GB/);
		}
	});

	it('does not use "item(s)" and works for a count of one', () => {
		for (const key of ['progress.items', 'progress.successBody']) {
			expect(en[key as keyof typeof en]).not.toContain('(s)');
			expect(en[key as keyof typeof en]).not.toMatch(/\{count\} items/);
		}
	});

	it('says that only time-limited shares expire', () => {
		expect(en['retrieve.how3']).toMatch(/time-limited/i);
		expect(ja['retrieve.how3']).toContain('期限付き');
		expect(zhHant['retrieve.how3']).toContain('有期限');
		for (const [name, messages] of Object.entries(locales)) {
			expect(messages['retrieve.how3'], name).toMatch(/永久|無期限|permanent/i);
		}
	});
});
