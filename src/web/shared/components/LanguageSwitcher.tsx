import { LOCALES, Locale } from '@/i18n';
import { useI18n } from '@/i18n/I18nProvider';

// Switches the interface language in place; the page does not reload and no share code changes
export function LanguageSwitcher() {
	const { locale, setLocale, t } = useI18n();
	return (
		<label className="inline-flex items-center gap-2 text-sm text-gray-600">
			<span className="sr-only">{t('language.label')}</span>
			<select
				value={locale}
				onChange={(event) => setLocale(event.target.value as Locale)}
				className="border border-gray-300 rounded px-2 py-1 bg-white"
			>
				{LOCALES.map((item) => (
					<option key={item} value={item}>
						{t(`language.${item}` as 'language.en')}
					</option>
				))}
			</select>
		</label>
	);
}
