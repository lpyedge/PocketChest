import { useCallback, useEffect, useRef, useState } from 'react';
import { sharesApi, ShareRecord } from '@/lib/shares-api';
import { AuthRequestError } from '@/lib/auth-api';
import { codeKeyFor } from '@/lib/errors';
import { formatBytes } from '@/lib/format';
import { getShareLink } from '@/lib/share';
import { useI18n } from '@/i18n/I18nProvider';
import type { ValidityDays } from '@/lib/types';

interface ShareManagementModalProps {
	csrfToken: string;
	onClose: () => void;
	// The Owner session is gone (expired or ended elsewhere): the page goes back to sign-in
	onSignedOut: () => void;
}

const EXTEND_OPTIONS: { value: ValidityDays; label: 'expiry.1d' | 'expiry.3d' | 'expiry.1w' | 'expiry.2w' | 'expiry.permanent' }[] = [
	{ value: 1, label: 'expiry.1d' },
	{ value: 3, label: 'expiry.3d' },
	{ value: 7, label: 'expiry.1w' },
	{ value: 14, label: 'expiry.2w' },
	{ value: -1, label: 'expiry.permanent' },
];

const FOCUSABLE = 'button:not([disabled]), select:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function ShareManagementModal({ csrfToken, onClose, onSignedOut }: ShareManagementModalProps) {
	const { t, locale } = useI18n();
	const [shares, setShares] = useState<ShareRecord[] | null>(null);
	const [cursor, setCursor] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [message, setMessage] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);
	const [busyId, setBusyId] = useState<string | null>(null);
	const [copied, setCopied] = useState<string | null>(null);
	const [extendDays, setExtendDays] = useState<Record<string, ValidityDays>>({});
	const dialogRef = useRef<HTMLDivElement>(null);

	const failure = useCallback(
		(error: unknown) => {
			if (error instanceof AuthRequestError && error.status === 401) {
				onSignedOut();
				return t('error.signInRequired');
			}
			if (error instanceof AuthRequestError) {
				return t(codeKeyFor(error.code) ?? 'shares.actionFailed');
			}
			return t('shares.actionFailed');
		},
		[onSignedOut, t],
	);

	// Loads the first page (replace) or the next one (append). A failure keeps what is already on screen.
	const load = useCallback(
		async (from: string | null, replace: boolean) => {
			setLoading(true);
			try {
				const page = await sharesApi.list(from);
				setShares((current) => (replace || !current ? page.shares : [...current, ...page.shares]));
				setCursor(page.cursor);
				if (replace) setMessage(null);
			} catch (error) {
				setMessage({
					kind: 'error',
					text: error instanceof AuthRequestError && error.status !== 401 ? t('shares.loadFailed') : failure(error),
				});
			} finally {
				setLoading(false);
			}
		},
		[failure, t],
	);

	useEffect(() => {
		load(null, true);
	}, [load]);

	// Every row on screen was revoked but the server has more: keep going instead of showing an empty list
	useEffect(() => {
		if (shares !== null && shares.length === 0 && cursor && !loading) load(cursor, false);
	}, [shares, cursor, loading, load]);

	// Keyboard: focus moves into the dialog, Tab stays inside it, Escape closes it, focus returns to where it was
	useEffect(() => {
		const previous = document.activeElement as HTMLElement | null;
		dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
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
		return () => {
			document.removeEventListener('keydown', onKey);
			previous?.focus?.();
		};
	}, [onClose]);

	const copy = async (id: string, text: string) => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(id);
			setTimeout(() => setCopied((current) => (current === id ? null : current)), 2000);
		} catch {
			setMessage({ kind: 'error', text: t('share.copyFailed') });
		}
	};

	const extend = async (share: ShareRecord) => {
		const days = extendDays[share.sessionId] ?? 7;
		setBusyId(share.sessionId);
		try {
			const { expiresAt } = await sharesApi.extend(csrfToken, share.sessionId, days);
			setShares((current) => current?.map((item) => (item.sessionId === share.sessionId ? { ...item, expiresAt } : item)) ?? null);
			setMessage({ kind: 'ok', text: t('shares.extended') });
		} catch (error) {
			setMessage({ kind: 'error', text: failure(error) });
		} finally {
			setBusyId(null);
		}
	};

	const revoke = async (share: ShareRecord) => {
		if (!window.confirm(t('shares.revokeConfirm', { code: share.retrievalCode }))) return;
		setBusyId(share.sessionId);
		try {
			await sharesApi.revoke(csrfToken, share.sessionId);
			setShares((current) => current?.filter((item) => item.sessionId !== share.sessionId) ?? null);
			setMessage({ kind: 'ok', text: t('shares.revoked') });
		} catch (error) {
			setMessage({ kind: 'error', text: failure(error) });
		} finally {
			setBusyId(null);
		}
	};

	const expiryText = (share: ShareRecord) =>
		share.expiresAt === null
			? t('retrieve.expiresNever')
			: t('retrieve.expires', { date: new Date(share.expiresAt * 1000).toLocaleString(locale) });

	return (
		<div
			className="fixed inset-0 bg-black/40 flex items-start justify-center p-4 overflow-y-auto z-50"
			role="dialog"
			aria-modal="true"
			aria-label={t('shares.title')}
		>
			<div ref={dialogRef} className="bg-white rounded-lg shadow-xl w-full max-w-2xl p-4 sm:p-6 mt-6 sm:mt-10">
				<div className="flex justify-between items-center mb-4 gap-2">
					<h2 className="text-xl font-bold text-gray-900">{t('shares.title')}</h2>
					<div className="flex items-center gap-3">
						<button
							type="button"
							onClick={() => load(null, true)}
							disabled={loading}
							className="text-sm text-blue-600 underline disabled:text-gray-400"
						>
							{t('shares.refresh')}
						</button>
						<button type="button" onClick={onClose} aria-label={t('common.close')} className="text-gray-500 hover:text-gray-800">
							✕
						</button>
					</div>
				</div>

				{message && (
					<p
						role={message.kind === 'error' ? 'alert' : 'status'}
						className={`mb-3 text-sm ${message.kind === 'error' ? 'text-red-700' : 'text-green-700'}`}
					>
						{message.text}
					</p>
				)}

				{shares === null && loading && <p className="text-gray-600">{t('common.loading')}</p>}
				{shares !== null && shares.length === 0 && !loading && !cursor && <p className="text-gray-600">{t('shares.empty')}</p>}

				<ul className="space-y-3">
					{shares?.map((share) => (
						<li key={share.sessionId} data-testid="share-row" className="border border-gray-200 rounded-lg p-3">
							<div className="flex flex-wrap items-center justify-between gap-2">
								<code className="text-lg font-mono tracking-widest text-gray-900">{share.retrievalCode}</code>
								<div className="flex gap-3 text-sm">
									<button
										type="button"
										onClick={() => copy(`${share.sessionId}:code`, share.retrievalCode)}
										className="text-blue-600 underline"
									>
										{copied === `${share.sessionId}:code` ? t('shares.copied') : t('shares.copyCode')}
									</button>
									<button
										type="button"
										onClick={() => copy(`${share.sessionId}:link`, getShareLink(share.retrievalCode))}
										className="text-blue-600 underline"
									>
										{copied === `${share.sessionId}:link` ? t('shares.copied') : t('shares.copyLink')}
									</button>
								</div>
							</div>
							<p className="text-sm text-gray-600 mt-1 break-words">
								{t('shares.summary', {
									count: share.fileCount,
									size: formatBytes(share.totalSize, locale, { zero: t('size.zero'), bytes: t('size.bytes') }),
								})}
							</p>
							<p className="text-sm text-gray-600 break-words">
								{t('shares.created', { date: new Date(share.createdAt * 1000).toLocaleString(locale) })}
							</p>
							<p className="text-sm text-gray-600 break-words">{expiryText(share)}</p>
							<div className="flex flex-wrap items-center gap-2 mt-3">
								<select
									aria-label={t('shares.extendTo')}
									value={extendDays[share.sessionId] ?? 7}
									onChange={(event) =>
										setExtendDays((current) => ({ ...current, [share.sessionId]: Number(event.target.value) as ValidityDays }))
									}
									className="border border-gray-300 rounded px-2 py-1 text-sm"
								>
									{EXTEND_OPTIONS.map((option) => (
										<option key={option.value} value={option.value}>
											{t(option.label)}
										</option>
									))}
								</select>
								<button
									type="button"
									onClick={() => extend(share)}
									disabled={busyId === share.sessionId}
									className="px-3 py-1 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 disabled:bg-gray-300"
								>
									{t('shares.extend')}
								</button>
								<button
									type="button"
									onClick={() => revoke(share)}
									disabled={busyId === share.sessionId}
									className="px-3 py-1 text-sm border border-red-300 text-red-700 rounded hover:bg-red-50 disabled:text-gray-400"
								>
									{t('shares.revoke')}
								</button>
							</div>
						</li>
					))}
				</ul>

				{cursor && (
					<button
						type="button"
						onClick={() => load(cursor, false)}
						disabled={loading}
						className="mt-4 w-full py-2 text-sm border border-gray-300 rounded hover:bg-gray-50 disabled:text-gray-400"
					>
						{loading ? t('common.loading') : t('shares.loadMore')}
					</button>
				)}
			</div>
		</div>
	);
}
