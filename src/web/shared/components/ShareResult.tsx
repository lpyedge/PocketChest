import { useState } from 'react';
import { getRetrievePageUrl, getShareLink } from '@/lib/share';
import { useI18n } from '@/i18n/I18nProvider';

interface ShareResultProps {
	code: string;
}

type CopyTarget = 'link' | 'page' | 'code' | 'message';

export function ShareResult({ code }: ShareResultProps) {
	const { t } = useI18n();
	const [copied, setCopied] = useState<CopyTarget | null>(null);
	const [message, setMessage] = useState<string | null>(null);

	const shareLink = getShareLink(code);
	const retrievePageUrl = getRetrievePageUrl();
	// The message is written in the current language and names the retrieval page and the code separately.
	// The direct link keeps its own /retrieve/#CODE form and has its own copy button.
	const shareMessage = t('share.message', { page: retrievePageUrl, code });

	const copy = async (target: CopyTarget, text: string) => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(target);
			setTimeout(() => setCopied(null), 2000);
		} catch (error) {
			console.error('Copy failed:', error);
			setMessage(t('share.copyFailed'));
		}
	};

	const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

	const nativeShare = async () => {
		try {
			await navigator.share({ title: 'PocketChest', url: shareLink });
		} catch {
			// User dismissed the share sheet
		}
	};

	const copyButton = (target: CopyTarget, text: string, label = t('share.copy')) => (
		<button
			onClick={() => copy(target, text)}
			className={`shrink-0 px-3 py-2 rounded-lg border-2 text-sm font-medium transition-colors ${
				copied === target
					? 'text-green-600 bg-green-50 border-green-200'
					: 'text-blue-600 hover:bg-blue-50 border-blue-200 hover:border-blue-300'
			}`}
		>
			{copied === target ? t('share.copied') : label}
		</button>
	);

	return (
		<div className="space-y-4 mb-8 text-left">
			{message && (
				<p role="status" className="text-sm text-red-700">
					{message}
				</p>
			)}
			<div className="bg-gray-50 rounded-lg p-5">
				<p className="text-sm text-gray-600 mb-2 font-medium">{t('share.directLink')}</p>
				<div className="flex items-center gap-2">
					<code className="flex-1 min-w-0 truncate font-mono text-blue-600 bg-white px-3 py-2 rounded-lg border-2 border-blue-200">
						{shareLink}
					</code>
					{copyButton('link', shareLink)}
				</div>
				{canNativeShare && (
					<button
						onClick={nativeShare}
						className="mt-3 w-full py-2 rounded-lg border-2 border-blue-200 text-blue-600 hover:bg-blue-50 font-medium"
					>
						{t('share.share')}
					</button>
				)}
			</div>

			<div className="bg-gray-50 rounded-lg p-5">
				<p className="text-sm text-gray-600 mb-2 font-medium">{t('share.pageAndCode')}</p>
				<div className="flex items-center gap-2 mb-2">
					<code className="flex-1 min-w-0 truncate font-mono text-gray-700 bg-white px-3 py-2 rounded-lg border-2 border-gray-200">
						{retrievePageUrl}
					</code>
					{copyButton('page', retrievePageUrl)}
				</div>
				<div className="flex items-center gap-2 mb-3">
					<code className="flex-1 text-center text-3xl font-mono font-bold text-blue-600 bg-white px-3 py-2 rounded-lg border-2 border-blue-200">
						{code}
					</code>
					{copyButton('code', code)}
				</div>
				{copyButton('message', shareMessage, t('share.copyAsMessage'))}
			</div>
		</div>
	);
}
