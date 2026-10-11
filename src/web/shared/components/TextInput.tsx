import { useState } from 'react';
import { Toggle } from '@/components/Toggle';
import { useI18n } from '@/i18n/I18nProvider';

interface TextInputProps {
	value: string;
	onChange: (value: string) => void;
}

// Text is optional and secondary to files: it stays behind a switch, and one box holds all of it
export function TextInput({ value, onChange }: TextInputProps) {
	const { t } = useI18n();
	const [open, setOpen] = useState(value.length > 0);

	const setVisible = (next: boolean) => {
		// Hidden text would still be uploaded, so closing the box discards it (after asking, when there is some)
		if (!next && value.trim() && !window.confirm(t('text.discardConfirm'))) return;
		if (!next) onChange('');
		setOpen(next);
	};

	return (
		<div>
			<div className="flex items-center justify-between gap-3">
				<span className="text-sm font-medium text-gray-900">{t('text.toggle')}</span>
				<Toggle checked={open} onChange={setVisible} label={t('text.toggle')} />
			</div>
			{open && (
				<textarea
					value={value}
					onChange={(event) => onChange(event.target.value)}
					placeholder={t('text.placeholder')}
					aria-label={t('text.content')}
					autoFocus
					className="mt-3 block h-40 w-full resize-y rounded-lg border border-gray-300 p-3 font-mono text-sm focus:border-blue-500 focus:outline-2 focus:outline-blue-500"
				/>
			)}
		</div>
	);
}
