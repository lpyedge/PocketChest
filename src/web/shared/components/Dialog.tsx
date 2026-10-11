import { useEffect, useRef, type ReactNode } from 'react';
import { IconButton } from '@/components/IconButton';
import { CloseIcon } from '@/components/Icons';
import { useI18n } from '@/i18n/I18nProvider';

const FOCUSABLE =
	'button:not([disabled]), select:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface DialogProps {
	title: string;
	icon?: ReactNode;
	children: ReactNode;
	onClose: () => void;
	// Extra controls in the title bar, left of the close button
	actions?: ReactNode;
	wide?: boolean;
}

// The shared modal. Keyboard: focus moves into it, Tab stays inside, Escape closes it, and focus returns to where it was
export function Dialog({ title, icon, children, onClose, actions, wide = false }: DialogProps) {
	const { t } = useI18n();
	const dialogRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const previous = document.activeElement as HTMLElement | null;
		// The first control that is not the close button, so typing can start at once
		const items = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
		(items && (items[1] ?? items[0]))?.focus();
		return () => previous?.focus?.();
	}, []);

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				onClose();
				return;
			}
			if (event.key !== 'Tab' || !dialogRef.current) return;
			const items = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
			if (items.length === 0) return;
			const first = items[0];
			const last = items[items.length - 1];
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first.focus();
			}
		};
		document.addEventListener('keydown', onKey);
		return () => document.removeEventListener('keydown', onKey);
	}, [onClose]);

	return (
		<div
			className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4"
			role="dialog"
			aria-modal="true"
			aria-label={title}
		>
			<div ref={dialogRef} className={`mt-6 w-full rounded-2xl bg-white shadow-xl sm:mt-10 ${wide ? 'max-w-2xl' : 'max-w-lg'}`}>
				<div className="flex items-center justify-between gap-3 border-b border-gray-100 px-4 py-3 sm:px-5">
					<h2 className="flex items-center gap-2 text-base font-semibold text-gray-900">
						{icon && <span className="text-gray-500">{icon}</span>}
						{title}
					</h2>
					<div className="flex items-center gap-1">
						{actions}
						<IconButton label={t('common.close')} onClick={onClose} align="right">
							<CloseIcon />
						</IconButton>
					</div>
				</div>
				<div className="px-4 py-4 sm:px-5 sm:py-5">{children}</div>
			</div>
		</div>
	);
}
