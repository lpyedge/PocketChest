import { useState } from 'react';
import { Toggle } from '@/components/Toggle';
import { CloseIcon, PlusIcon } from '@/components/Icons';
import { useI18n } from '@/i18n/I18nProvider';

interface TextInputProps {
	values: string[];
	onChange: (values: string[]) => void;
}

// Text is optional and secondary to files: it stays collapsed behind a switch until needed.
// Typing is the save: every keystroke updates the share, and the add button appends another note.
export function TextInput({ values, onChange }: TextInputProps) {
	const { t } = useI18n();
	const [open, setOpen] = useState(values.some((value) => value.length > 0));

	const filled = values.filter((value) => value.trim().length > 0).length;

	const setVisible = (next: boolean) => {
		// Hidden text would still be uploaded, so closing the section discards it (after asking, when there is some)
		if (!next && values.some((value) => value.trim()) && !window.confirm(t('text.discardConfirm'))) return;
		if (next && values.length === 0) onChange(['']);
		if (!next) onChange([]);
		setOpen(next);
	};

	const updateAt = (index: number, content: string) => onChange(values.map((value, i) => (i === index ? content : value)));

	const removeAt = (index: number) => {
		if (values[index].trim() && !window.confirm(t('text.removeConfirm'))) return;
		onChange(values.filter((_, i) => i !== index));
	};

	return (
		<div>
			<div className="flex items-center justify-between gap-3">
				<div className="min-w-0">
					<p className="text-sm font-medium text-gray-900">{t('text.toggle')}</p>
					<p className="mt-0.5 text-xs text-gray-500">{open && filled > 0 ? t('progress.items', { count: filled }) : t('text.hint')}</p>
				</div>
				<Toggle checked={open} onChange={setVisible} label={t('text.toggle')} />
			</div>
			{open && (
				<div className="mt-3 space-y-3">
					{values.map((value, index) => (
						<div key={index} className="rounded-xl border border-gray-200 bg-gray-50/60 p-2.5">
							<div className="mb-1.5 flex items-center justify-between gap-2">
								<span className="text-xs font-medium text-gray-500">
									{t('text.content')}
									{values.length > 1 ? ` ${index + 1}` : ''}
								</span>
								<div className="flex items-center gap-1.5">
									<span className="text-[11px] tabular-nums text-gray-400">{t('progress.chars', { count: value.length })}</span>
									<button
										type="button"
										onClick={() => removeAt(index)}
										aria-label={t('text.removeItem', { n: index + 1 })}
										title={t('text.removeItem', { n: index + 1 })}
										className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600"
									>
										<CloseIcon width={14} height={14} />
									</button>
								</div>
							</div>
							<textarea
								value={value}
								onChange={(event) => updateAt(index, event.target.value)}
								placeholder={t('text.placeholder')}
								aria-label={`${t('text.content')}${values.length > 1 ? ` ${index + 1}` : ''}`}
								autoFocus={index === values.length - 1}
								rows={4}
								className="block w-full resize-y rounded-lg border border-gray-200 bg-white p-3 font-mono text-sm focus:border-blue-500 focus:outline-2 focus:outline-blue-500"
							/>
						</div>
					))}
					<button
						type="button"
						onClick={() => onChange([...values, ''])}
						className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-gray-300 py-2.5 text-sm font-medium text-gray-600 transition-colors hover:border-gray-400 hover:bg-gray-50 hover:text-gray-900"
					>
						<PlusIcon width={16} height={16} />
						{t('text.add')}
					</button>
				</div>
			)}
		</div>
	);
}
