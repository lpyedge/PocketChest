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

const EXTEND_OPTIONS: { value: ValidityDays; label: 'expiry.1d' | 'expiry.3d' | 'expiry.1w' | 'expiry.2w' | 'expiry.permanent' }[] = [
	{ value: 1, label: 'expiry.1d' },
	{ value: 3, label: 'expiry.3d' },
	{ value: 7, label: 'expiry.1w' },
	{ value: 14, label: 'expiry.2w' },
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
					const dateFormat: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'short' };
					return (
						<li key={share.sessionId} data-testid="share-row" className="rounded-xl border border-gray-200 px-3 py-2">
							{/* Line 1: the code, what is in it, and the actions */}
							<div className="flex items-center justify-between gap-2">
								<div className="flex min-w-0 items-baseline gap-2">
									<code className="font-mono text-base font-semibold tracking-wider text-gray-900">{share.retrievalCode}</code>
									<span className="truncate text-xs text-gray-500">
										{t('shares.summary', {
											count: share.fileCount,
											size: formatBytes(share.totalSize, locale, { zero: t('size.zero'), bytes: t('size.bytes') }),
										})}
									</span>
								</div>
								<div className="-mr-1 flex shrink-0 items-center">
									<IconButton
										label={copied === `${share.sessionId}:code` ? t('shares.copied') : t('shares.copyCode')}
										onClick={() => copy(`${share.sessionId}:code`, share.retrievalCode)}
										className="h-8 w-8"
									>
										{copied === `${share.sessionId}:code` ? <CheckIcon className="text-green-600" /> : <KeyIcon />}
									</IconButton>
									<IconButton
										label={copied === `${share.sessionId}:link` ? t('shares.copied') : t('shares.copyLink')}
										onClick={() => copy(`${share.sessionId}:link`, getShareLink(share.retrievalCode))}
										className="h-8 w-8"
									>
										{copied === `${share.sessionId}:link` ? <CheckIcon className="text-green-600" /> : <LinkIcon />}
									</IconButton>
									<IconButton
										label={t('shares.revoke')}
										onClick={() => revoke(share)}
										disabled={busyId === share.sessionId}
										align="right"
										className="h-8 w-8"
									>
										<TrashIcon className="text-red-600" />
									</IconButton>
								</div>
							</div>
							{/* Line 2: when, and the way to extend it */}
							<div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
								<p className="min-w-0 text-xs text-gray-500">
									{t('shares.created', { date: new Date(share.createdAt * 1000).toLocaleString(locale, dateFormat) })}
									<span className="mx-1.5 text-gray-300">·</span>
									{share.expiresAt === null
										? t('retrieve.expiresNever')
										: t('retrieve.expires', { date: new Date(share.expiresAt * 1000).toLocaleString(locale, dateFormat) })}
								</p>
								<div className="flex items-center gap-1.5">
									<select
										aria-label={t('shares.extendTo')}
										value={extendDays[share.sessionId] ?? 7}
										onChange={(event) =>
											setExtendDays((current) => ({ ...current, [share.sessionId]: Number(event.target.value) as ValidityDays }))
										}
										className="rounded-md border border-gray-300 bg-white px-1.5 py-0.5 text-xs"
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
										className="rounded-md bg-blue-600 px-2.5 py-0.5 text-xs font-medium text-white hover:bg-blue-700 disabled:bg-gray-300"
									>
										{t('shares.extend')}
									</button>
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
