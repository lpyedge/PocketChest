import { ValidityDays } from '@/lib/types';
import { MessageKey, useI18n } from '@/i18n/I18nProvider';

interface ExpirySelectorProps {
	value: ValidityDays;
	onChange: (days: ValidityDays) => void;
}

const expiryOptions: { value: ValidityDays; label: MessageKey; description: MessageKey }[] = [
	{ value: 1, label: 'expiry.1d', description: 'expiry.1d.desc' },
	{ value: 3, label: 'expiry.3d', description: 'expiry.3d.desc' },
	{ value: 7, label: 'expiry.1w', description: 'expiry.1w.desc' },
	{ value: 15, label: 'expiry.2w', description: 'expiry.2w.desc' },
	{ value: -1, label: 'expiry.permanent', description: 'expiry.permanent.desc' },
];

export function ExpirySelector({ value, onChange }: ExpirySelectorProps) {
	const { t } = useI18n();
	return (
		<div className="space-y-2">
			<label className="block text-sm font-medium text-gray-700">{t('expiry.label')}</label>
			<div className="grid grid-cols-1 sm:grid-cols-5 gap-2">
				{expiryOptions.map((option) => (
					<button
						key={option.value}
						onClick={() => onChange(option.value)}
						className={`
              p-3 rounded-lg border text-left transition-colors
              ${
								value === option.value
									? 'border-blue-500 bg-blue-50 text-blue-700'
									: 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
							}
            `}
					>
						<div className="font-medium text-sm">{t(option.label)}</div>
						<div className="text-xs text-gray-500 mt-1">{t(option.description)}</div>
					</button>
				))}
			</div>
		</div>
	);
}
