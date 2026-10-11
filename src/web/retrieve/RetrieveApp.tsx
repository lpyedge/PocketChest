import { useState, useEffect } from 'react';
import { RetrieveClient } from '@/components/RetrieveClient';
import { readCodeFromLocation } from '@/lib/share';
import { useI18n } from '@/i18n/I18nProvider';
import { AppHeader } from '@/components/AppHeader';
import { IconButton } from '@/components/IconButton';
import { KeyIcon } from '@/components/Icons';
import { appUrl } from '@/lib/home';

export default function RetrieveApp() {
	const { t, locale } = useI18n();

	useEffect(() => {
		document.title = t('retrieve.docTitle');
	}, [t]);
	const [retrievalCode, setRetrievalCode] = useState('');
	const [showFiles, setShowFiles] = useState(false);

	// The code travels in the URL fragment (/retrieve/#ABC123), which is never sent to the server
	useEffect(() => {
		const syncFromLocation = () => {
			const code = readCodeFromLocation();
			if (code) {
				setRetrievalCode(code);
				setShowFiles(true);
			} else {
				setRetrievalCode('');
				setShowFiles(false);
			}
		};

		syncFromLocation();
		window.addEventListener('hashchange', syncFromLocation);
		return () => window.removeEventListener('hashchange', syncFromLocation);
	}, []);

	const handleRetrieve = () => {
		const code = retrievalCode.trim();
		if (!code) {
			alert(t('retrieve.needCode'));
			return;
		}

		if (code.length !== 6) {
			alert(t('retrieve.codeLength'));
			return;
		}

		// Update URL and show files
		window.history.pushState({}, '', `/retrieve/#${code}`);
		setShowFiles(true);
	};

	const handleKeyPress = (e: React.KeyboardEvent) => {
		if (e.key === 'Enter') {
			handleRetrieve();
		}
	};

	const handleBack = () => {
		window.history.pushState({}, '', '/retrieve/');
		setShowFiles(false);
		setRetrievalCode('');
	};

	if (showFiles && retrievalCode) {
		return <RetrieveClient key={retrievalCode} code={retrievalCode} onBack={handleBack} />;
	}

	return (
		<div className="min-h-screen bg-gray-50">
			<AppHeader>
				<IconButton label={t('nav.enterCode')} onClick={handleBack} align="right">
					<KeyIcon />
				</IconButton>
			</AppHeader>
			<main className="mx-auto max-w-md px-4 py-10">
				<div className="mb-6 text-center">
					<h1 className="text-xl font-semibold text-gray-900">{t('retrieve.pageTitle')}</h1>
					<p className="mt-1 text-sm text-gray-600">{t('retrieve.enterCode')}</p>
				</div>

				<div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
					<div className="space-y-5">
						<div>
							<label htmlFor="retrieval-code" className="mb-2 block text-sm font-medium text-gray-900">
								{t('retrieve.codeField')}
							</label>
							<input
								id="retrieval-code"
								type="text"
								value={retrievalCode}
								onChange={(e) => setRetrievalCode(e.target.value.toUpperCase())}
								onKeyDown={handleKeyPress}
								placeholder="A1B2C3"
								maxLength={6}
								autoFocus
								autoComplete="off"
								className="w-full rounded-lg border-2 border-gray-300 p-3 text-center font-mono text-xl font-bold tracking-widest focus:border-blue-500 focus:outline-none"
							/>
							<div className="mt-2 flex items-center justify-between">
								<p className="text-xs text-gray-500">{t('retrieve.codeHelp')}</p>
								<p className={`text-xs ${retrievalCode.length === 6 ? 'text-green-600' : 'text-gray-400'}`}>{retrievalCode.length}/6</p>
							</div>
						</div>

						<button
							onClick={handleRetrieve}
							disabled={retrievalCode.trim().length !== 6}
							className="w-full rounded-lg bg-blue-600 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300"
						>
							{t('retrieve.access')}
						</button>

						<p className="text-center text-sm text-gray-500">
							{t('retrieve.noCode')}{' '}
							<a href={appUrl('/upload/', locale)} className="font-medium text-blue-600 hover:text-blue-800">
								{t('retrieve.shareInstead')}
							</a>
						</p>
					</div>
				</div>

				<div className="mt-6 space-y-1 rounded-xl bg-white/60 p-4 text-xs text-gray-600">
					<h2 className="mb-1 text-sm font-medium text-gray-900">{t('retrieve.howTitle')}</h2>
					<p>{t('retrieve.how1')}</p>
					<p>{t('retrieve.how2')}</p>
					<p>{t('retrieve.how3')}</p>
				</div>
			</main>
		</div>
	);
}
