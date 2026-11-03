import { useCallback, useEffect, useState } from 'react';
import { Dialog } from '@/components/Dialog';
import { IconButton } from '@/components/IconButton';
import { CheckIcon, CopyIcon, KeyIcon, LinkIcon, RefreshIcon, TrashIcon, ListIcon } from '@/components/Icons';
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

const EXTEND_OPTIONS: {
	value: ValidityDays;
	label: 'expiry.1d' | 'expiry.3d' | 'expiry.1w' | 'expiry.2w' | 'expiry.1m' | 'expiry.3m' | 'expiry.permanent';
}[] = [
	{ value: 1, label: 'expiry.1d' },
	{ value: 3, label: 'expiry.3d' },
	{ value: 7, label: 'expiry.1w' },
	{ value: 14, label: 'expiry.2w' },
	{ value: 30, label: 'expiry.1m' },
	{ value: 90, label: 'expiry.3m' },
	{ value: -1, label: 'expiry.permanent' },
];

export function ShareManagementModal({ csrfToken, onClose, onSignedOut }: ShareManagementModalProps) {
	const { t, locale } = useI18n();
	const [shares, setShares] = useState<ShareRecord[] | null>(null);
	const [cursor, setCursor] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [message, setMessage] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);
	const [busyId, setBusyId] = useState<string | null>(null);
	const [copied, setCopied] = useState<string | null>(null);
	const [extendDays, setExtendDays] = useState<Record<string, ValidityDays>>({});

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

	// Every row on screen was revoked but the server has more: keep going instead of showing an empty list. Not after a
	// failed load: nothing would change, so it would ask again at once, forever; "Load more" stays there to retry.
	useEffect(() => {
		if (shares !== null && shares.length === 0 && cursor && !loading && message?.kind !== 'error') load(cursor, false);
	}, [shares, cursor, loading, load, message]);

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

	return (
		<Dialog
			title={t('shares.title')}
			icon={<ListIcon width={18} height={18} />}
			onClose={onClose}
			wide
			actions={
				<IconButton label={t('shares.refresh')} onClick={() => load(null, true)} disabled={loading}>
					<RefreshIcon />
				</IconButton>
			}
		>
			{message && (
				<p
					role={message.kind === 'error' ? 'alert' : 'status'}
					className={`mb-3 text-sm ${message.kind === 'error' ? 'text-red-700' : 'text-green-700'}`}
				>
					{message.text}
				</p>
			)}

			{shares === null && loading && <p className="text-sm text-gray-600">{t('common.loading')}</p>}
			{shares !== null && shares.length === 0 && !loading && !cursor && (
				<p className="py-6 text-center text-sm text-gray-500">{t('shares.empty')}</p>
			)}

			<ul className="space-y-2">
				{shares?.map((share) => {
					const dateFormat: Intl.DateTimeFormatOptions = { dateStyle: 'medium' };
					const fullFormat: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };
					const createdFull = new Date(share.createdAt * 1000).toLocaleString(locale, fullFormat);
					const expiresFull = share.expiresAt === null ? null : new Date(share.expiresAt * 1000).toLocaleString(locale, fullFormat);
					const selectId = `extend-${share.sessionId}`;
					const chosen = extendDays[share.sessionId] ?? 7;
					const preview =
						chosen === -1
							? t('shares.newExpiryNever')
							: t('shares.newExpiry', {
									date: new Date(Date.now() + chosen * 86400 * 1000).toLocaleString(locale, dateFormat),
								});
					const remaining = share.expiresAt === null ? null : share.expiresAt - Date.now() / 1000;
					const expiryClass =
						share.expiresAt === null
							? 'text-emerald-700'
							: remaining !== null && remaining < 3 * 86400
								? 'font-medium text-amber-700'
								: 'text-gray-500';
					return (
						<li key={share.sessionId} data-testid="share-row" className="relative rounded-xl border border-gray-200 px-3 py-2 sm:px-4">
							<div className="absolute -top-2 -right-2 rounded-full bg-white/80 shadow-md ring-1 ring-black/10 backdrop-blur-sm">
								<IconButton
									label={t('shares.revoke')}
									onClick={() => revoke(share)}
									disabled={busyId === share.sessionId}
									align="right"
									className="[--iconbtn-size:1.75rem]"
								>
									<TrashIcon width={20} height={20} className="text-red-600" />
								</IconButton>
							</div>
							<div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
								{/* Left: what the share is, and when it ends */}
								<div className="min-w-0 flex-1 pr-8 sm:pr-2">
									<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
										<code className="font-mono text-base font-semibold tracking-wider text-gray-900">{share.retrievalCode}</code>
										<span className="text-xs text-gray-500">
											{t('shares.summary', {
												count: share.fileCount,
												size: formatBytes(share.totalSize, locale, { zero: t('size.zero'), bytes: t('size.bytes') }),
											})}
										</span>
										<span className="-ml-1 inline-flex items-center">
											<IconButton
												label={copied === `${share.sessionId}:code` ? t('shares.copied') : t('shares.copyCode')}
												onClick={() => copy(`${share.sessionId}:code`, share.retrievalCode)}
												className="[--iconbtn-size:1.75rem]"
											>
												{copied === `${share.sessionId}:code` ? <CheckIcon className="text-green-600" /> : <KeyIcon />}
											</IconButton>
											<IconButton
												label={copied === `${share.sessionId}:link` ? t('shares.copied') : t('shares.copyLink')}
												onClick={() => copy(`${share.sessionId}:link`, getShareLink(share.retrievalCode))}
												className="[--iconbtn-size:1.75rem]"
											>
												{copied === `${share.sessionId}:link` ? <CheckIcon className="text-green-600" /> : <LinkIcon />}
											</IconButton>
										</span>
									</div>
									<p
										className="mt-1 text-xs text-gray-500"
										title={
											expiresFull === null
												? t('shares.created', { date: createdFull })
												: `${t('shares.created', { date: createdFull })} · ${t('retrieve.expires', { date: expiresFull })}`
										}
									>
										{t('shares.created', { date: new Date(share.createdAt * 1000).toLocaleDateString(locale, dateFormat) })}
										<span className="mx-1.5 text-gray-300">·</span>
										<span className={expiryClass}>
											{share.expiresAt === null
												? t('retrieve.expiresNever')
												: t('retrieve.expires', { date: new Date(share.expiresAt * 1000).toLocaleDateString(locale, dateFormat) })}
										</span>
									</p>
								</div>
								{/* Right: set a new expiry */}
								<div className="shrink-0 border-t border-gray-100 pt-2 sm:w-64 sm:border-l sm:border-t-0 sm:pl-4 sm:pt-0">
									<label htmlFor={selectId} className="mb-1 block text-[11px] font-medium text-gray-500">
										{t('shares.extendTo')}
									</label>
									<div className="flex items-center gap-1.5">
										<select
											id={selectId}
											value={chosen}
											onChange={(event) =>
												setExtendDays((current) => ({ ...current, [share.sessionId]: Number(event.target.value) as ValidityDays }))
											}
											className="min-w-0 flex-1 rounded-md border border-gray-300 bg-white px-1.5 py-1 text-xs"
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
											className="shrink-0 rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:bg-gray-300"
										>
											{t('shares.extend')}
										</button>
									</div>
									<p className="mt-1 text-[11px] leading-snug text-gray-500">{preview}</p>
								</div>
							</div>
						</li>
					);
				})}
			</ul>

			{cursor && (
				<button
					type="button"
					onClick={() => load(cursor, false)}
					disabled={loading}
					className="mt-4 w-full rounded-lg border border-gray-300 py-2 text-sm hover:bg-gray-50 disabled:text-gray-400"
				>
					{loading ? t('common.loading') : t('shares.loadMore')}
				</button>
			)}
		</Dialog>
	);
}
