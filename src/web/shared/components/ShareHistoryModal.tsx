import { useState } from 'react';
import { Dialog } from '@/components/Dialog';
import { IconButton } from '@/components/IconButton';
import { CheckIcon, CopyIcon, ExternalLinkIcon, HistoryIcon, TrashIcon } from '@/components/Icons';
import { clearHistory, HistoryEntry, loadHistory, removeHistory } from '@/lib/history';
import { describeExpiry } from '@/lib/expiry';
import { getShareLink } from '@/lib/share';
import { useI18n } from '@/i18n/I18nProvider';

export function ShareHistoryModal({ onClose }: { onClose: () => void }) {
	const { t, locale } = useI18n();
	const [entries, setEntries] = useState<HistoryEntry[]>(() => loadHistory());
	const [copied, setCopied] = useState<string | null>(null);

	const copyLink = async (code: string) => {
		try {
			await navigator.clipboard.writeText(getShareLink(code));
			setCopied(code);
			setTimeout(() => setCopied((current) => (current === code ? null : current)), 2000);
		} catch (error) {
			console.error('Copy failed:', error);
		}
	};

	return (
		<Dialog title={t('history.title')} icon={<HistoryIcon width={18} height={18} />} onClose={onClose}>
			{entries.length === 0 ? (
				<p className="py-8 text-center text-sm text-gray-500">{t('history.empty')}</p>
			) : (
				<ul className="divide-y divide-gray-100 rounded-xl border border-gray-200">
					{entries.map((entry) => {
						const parts = [
							entry.files > 0 ? t('history.files', { count: entry.files }) : null,
							entry.texts > 0 ? t('history.text') : null,
						].filter(Boolean);
						return (
							<li key={entry.code} className="flex items-center justify-between gap-3 px-4 py-3">
								<div className="min-w-0">
									<p className="font-mono text-base font-semibold tracking-wider text-gray-900">{entry.code}</p>
									<p className="text-xs text-gray-500">{[...parts, new Date(entry.createdAt).toLocaleString(locale)].join(' · ')}</p>
									<p className="text-xs text-gray-400">
										{describeExpiry(entry.expiresAt === null ? null : new Date(entry.expiresAt).toISOString(), locale, t)}
									</p>
								</div>
								<div className="flex shrink-0 items-center">
									<IconButton
										label={copied === entry.code ? t('share.copied') : t('history.copyLink')}
										onClick={() => copyLink(entry.code)}
									>
										{copied === entry.code ? <CheckIcon className="text-green-600" /> : <CopyIcon />}
									</IconButton>
									<IconButton label={t('history.open')} href={`/retrieve/#${entry.code}`}>
										<ExternalLinkIcon />
									</IconButton>
									<IconButton label={t('common.remove')} onClick={() => setEntries(removeHistory(entry.code))} align="right">
										<TrashIcon />
									</IconButton>
								</div>
							</li>
						);
					})}
				</ul>
			)}
			<div className="mt-4 flex items-center justify-between gap-3">
				<p className="text-xs text-gray-500">{t('history.localNote')}</p>
				{entries.length > 0 && (
					<button
						type="button"
						onClick={() => {
							if (!window.confirm(t('history.clearConfirm'))) return;
							clearHistory();
							setEntries([]);
						}}
						className="shrink-0 text-sm text-red-700 hover:underline"
					>
						{t('history.clear')}
					</button>
				)}
			</div>
		</Dialog>
	);
}
