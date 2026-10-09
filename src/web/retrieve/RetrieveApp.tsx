import { useState, useEffect } from 'react';
import { RetrieveClient } from '@/components/RetrieveClient';
import { readCodeFromLocation } from '@/lib/share';
import { useI18n } from '@/i18n/I18nProvider';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { appUrl, homeUrlFor } from '@/lib/home';

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
		<main className="min-h-screen bg-linear-to-br from-green-50 via-white to-emerald-50 flex items-center justify-center p-4">
			<div className="max-w-md w-full">
				<div className="flex justify-end mb-2">
					<LanguageSwitcher />
				</div>
				<div className="text-center mb-8">
					<a href={homeUrlFor(locale)} className="text-green-600 hover:text-green-800 text-sm">
						{t('common.backHome')}
					</a>
					<div className="text-8xl mb-6 mt-4">📥</div>
					<h1 className="text-4xl font-bold text-gray-900 mb-4">{t('retrieve.pageTitle')}</h1>
					<p className="text-xl text-gray-600">{t('retrieve.enterCode')}</p>
				</div>

				<div className="bg-white rounded-2xl shadow-lg p-8">
					<div className="space-y-6">
						<div>
							<label className="block text-sm font-medium text-gray-700 mb-3">{t('retrieve.codeField')}</label>
							<input
								type="text"
								value={retrievalCode}
								onChange={(e) => setRetrievalCode(e.target.value.toUpperCase())}
								onKeyPress={handleKeyPress}
								placeholder="A1B2C3"
								maxLength={6}
								className="w-full p-4 text-center text-2xl font-mono font-bold border-2 border-gray-300 rounded-lg focus:ring-2 focus:ring-green-500 focus:border-green-500 transition-colors"
							/>
							<div className="flex justify-between items-center mt-2">
								<p className="text-xs text-gray-500">{t('retrieve.codeHelp')}</p>
								<p
									className={`text-xs ${
										retrievalCode.length === 6 ? 'text-green-600' : retrievalCode.length > 6 ? 'text-red-600' : 'text-gray-400'
									}`}
								>
									{retrievalCode.length}/6
								</p>
							</div>
						</div>

						<button
							onClick={handleRetrieve}
							disabled={!retrievalCode.trim() || retrievalCode.trim().length !== 6}
							className="w-full py-4 bg-green-500 text-white rounded-lg hover:bg-green-600 disabled:bg-gray-300 disabled:cursor-not-allowed font-semibold text-lg transition-colors"
						>
							{t('retrieve.access')}
						</button>

						<div className="text-center">
							<p className="text-sm text-gray-500">
								{t('retrieve.noCode')}{' '}
								<a href={appUrl('/upload/', locale)} className="text-green-600 hover:text-green-800 font-medium">
									{t('retrieve.shareInstead')}
								</a>
							</p>
						</div>
					</div>
				</div>

				<div className="mt-8 text-center">
					<div className="bg-white rounded-lg p-4 shadow-sm">
						<h3 className="font-medium text-gray-900 mb-2">{t('retrieve.howTitle')}</h3>
						<div className="text-sm text-gray-600 space-y-1">
							<p>{t('retrieve.how1')}</p>
							<p>{t('retrieve.how2')}</p>
							<p>{t('retrieve.how3')}</p>
						</div>
					</div>
				</div>
			</div>
		</main>
	);
}
