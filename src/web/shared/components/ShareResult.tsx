import { useState } from 'react';
import { getRetrievePageUrl, getShareLink } from '@/lib/share';
import { CheckIcon, CopyIcon } from '@/components/Icons';
import { useI18n } from '@/i18n/I18nProvider';

interface ShareResultProps {
	code: string;
}

type CopyTarget = 'link' | 'message';

// Two things to hand over: the link that opens the files right away, and a message that names the page and the code
export function ShareResult({ code }: ShareResultProps) {
	const { t } = useI18n();
	const [copied, setCopied] = useState<CopyTarget | null>(null);
	const [failed, setFailed] = useState(false);

	const shareLink = getShareLink(code);
	// The message is written in the current language and names the retrieval page and the code separately
	const shareMessage = t('share.message', { page: getRetrievePageUrl(), code });

	const copy = async (target: CopyTarget, text: string) => {
		try {
			await navigator.clipboard.writeText(text);
			setFailed(false);
			setCopied(target);
			setTimeout(() => setCopied(null), 2000);
		} catch (error) {
			console.error('Copy failed:', error);
			setFailed(true);
		}
	};

	const block = (target: CopyTarget, text: string, label: string, rows: number) => (
		<div className="space-y-2">
			<textarea
				readOnly
				rows={rows}
				value={text}
				aria-label={label}
				onFocus={(event) => event.currentTarget.select()}
				className="block field-sizing-content min-h-10 w-full resize-none rounded-lg border border-gray-300 bg-gray-50 p-3 font-mono text-sm text-gray-800 focus:border-blue-500 focus:outline-2 focus:outline-blue-500"
			/>
			<button
				type="button"
				onClick={() => copy(target, text)}
				className={`flex w-full items-center justify-center gap-2 rounded-lg border py-2 text-sm font-medium transition-colors ${
					copied === target ? 'border-green-200 bg-green-50 text-green-700' : 'border-blue-200 text-blue-700 hover:bg-blue-50'
				}`}
			>
				{copied === target ? <CheckIcon width={16} height={16} /> : <CopyIcon width={16} height={16} />}
				{copied === target ? t('share.copied') : t('share.copy')}
			</button>
		</div>
	);

	return (
		<div className="space-y-5 text-left">
			{failed && (
				<p role="status" className="text-sm text-red-700">
					{t('share.copyFailed')}
				</p>
			)}
			{block('link', shareLink, t('share.linkLabel'), 1)}
			{block('message', shareMessage, t('share.messageLabel'), 2)}
		</div>
	);
}
