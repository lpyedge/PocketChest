import type { MessageKey } from '../i18n';

// The text for the "expires" line of a chest. A permanent chest has no expiry date (null), and must never be
// fed to the date formatter: new Date(null) is 1 January 1970.
export function describeExpiry(
	expiryDate: string | null,
	locale: string,
	t: (key: MessageKey, params?: Record<string, string | number>) => string,
): string {
	if (expiryDate === null) {
		return t('retrieve.expiresNever');
	}
	const date = new Date(expiryDate);
	return t('retrieve.expires', { date: Number.isNaN(date.getTime()) ? expiryDate : date.toLocaleString(locale) });
}
