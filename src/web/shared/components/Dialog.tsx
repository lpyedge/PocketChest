import { useEffect, type ReactNode } from 'react';
import { IconButton } from '@/components/IconButton';
import { CloseIcon } from '@/components/Icons';
import { useI18n } from '@/i18n/I18nProvider';

export function Dialog({ title, icon, children, onClose }: { title: string; icon?: ReactNode; children: ReactNode; onClose: () => void }) {
	const { t } = useI18n();

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') onClose();
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [onClose]);

	return (
		<div
			className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4"
			role="dialog"
			aria-modal="true"
			aria-label={title}
		>
			<div className="mt-8 w-full max-w-lg rounded-2xl bg-white shadow-xl">
				<div className="flex items-center justify-between gap-3 border-b border-gray-100 px-5 py-4">
					<h2 className="flex items-center gap-2 text-base font-semibold text-gray-900">
						{icon && <span className="text-gray-500">{icon}</span>}
						{title}
					</h2>
					<IconButton label={t('common.close')} onClick={onClose} align="right">
						<CloseIcon />
					</IconButton>
				</div>
				<div className="px-5 py-5">{children}</div>
			</div>
		</div>
	);
}
