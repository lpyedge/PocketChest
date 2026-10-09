import { useState, useEffect } from 'react';
import { FileUpload } from '@/components/FileUpload';
import { TextInput } from '@/components/TextInput';
import { ExpirySelector } from '@/components/ExpirySelector';
import { UploadProgress } from '@/components/UploadProgress';
import { ShareResult } from '@/components/ShareResult';
import { usePocketChest } from '@/hooks/usePocketChest';
import { PocketChestAPI } from '@/lib/api';
import { authApi, AuthMethodsStatus } from '@/lib/auth-api';
import { AuthMethodPicker } from '@/components/AuthMethodPicker';
import { SecuritySettingsModal } from '@/components/SecuritySettingsModal';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { useI18n } from '@/i18n/I18nProvider';
import { ClientError, messageKeyFor } from '@/lib/errors';
import { TextItem, ValidityDays } from '@/lib/types';

export default function UploadApp() {
	const { t } = useI18n();
	const [files, setFiles] = useState<File[]>([]);
	const [textItems, setTextItems] = useState<TextItem[]>([]);
	const [validityDays, setValidityDays] = useState<ValidityDays>(7);
	const [uploadResult, setUploadResult] = useState<string | null>(null);
	const [sessionData, setSessionData] = useState<{ sessionId: string; uploadToken: string } | null>(null);

	// Owner sign-in: the CSRF token of the signed-in session, or null when nobody is signed in
	const [csrfToken, setCsrfToken] = useState<string | null>(null);
	const [authChecked, setAuthChecked] = useState(false);
	const [methods, setMethods] = useState<AuthMethodsStatus | null>(null);
	const [signOutError, setSignOutError] = useState<string | null>(null);
	const [showSecurity, setShowSecurity] = useState(false);
	const [startError, setStartError] = useState<string | null>(null);

	useEffect(() => {
		document.title = t('upload.docTitle');
	}, [t]);

	const { uploadWithSession, retryUpload, cancelUpload, isUploading, uploadProgress, uploadStatus, fileProgress, error, clearError } =
		usePocketChest();
	const api = new PocketChestAPI();

	// Check the owner session and which sign-in methods are on, once on load
	const loadAuth = () => {
		return Promise.all([authApi.session(), authApi.methods()])
			.then(([session, status]) => {
				setCsrfToken(session.authenticated ? (session.csrfToken ?? null) : null);
				setMethods(status);
			})
			.catch(() => {
				setCsrfToken(null);
				setMethods(null);
			})
			.finally(() => setAuthChecked(true));
	};

	useEffect(() => {
		loadAuth();
	}, []);

	const signOut = async () => {
		if (!csrfToken) return;
		setSignOutError(null);
		try {
			await authApi.logout(csrfToken);
			setCsrfToken(null);
			setSessionData(null);
			setUploadResult(null);
			await loadAuth();
		} catch {
			setSignOutError(t('upload.signOutFailed'));
		}
	};

	// Every upload runs in its own session: a session is closed by completing it, cancelling it or a failed attempt
	const startSession = async (): Promise<{ sessionId: string; uploadToken: string }> => {
		if (!csrfToken) {
			throw new ClientError('error.signInRequired');
		}
		const session = await api.createUploadSession(csrfToken);
		const started = { sessionId: session.sessionId, uploadToken: session.uploadToken };
		setSessionData(started);
		return started;
	};

	const runUpload = async (retry: boolean) => {
		if (files.length === 0 && textItems.length === 0) {
			alert(t('error.noItems'));
			return;
		}

		// Scroll to top to show upload progress
		setTimeout(() => {
			window.scrollTo({ top: 0, behavior: 'smooth' });
			// Fallback for older browsers
			document.body.scrollTop = 0;
			document.documentElement.scrollTop = 0;
		}, 100);

		// A previous attempt's session is abandoned on the server before a new one starts
		if (retry && sessionData) {
			await api.cancelSession(sessionData.sessionId, sessionData.uploadToken).catch(() => undefined);
		}
		setSessionData(null);

		setStartError(null);
		let session: { sessionId: string; uploadToken: string };
		try {
			session = await startSession();
		} catch (error) {
			setStartError(t(messageKeyFor(error)));
			return;
		}

		try {
			const result = retry
				? await retryUpload(session.sessionId, session.uploadToken, files, textItems, validityDays)
				: await uploadWithSession(session.sessionId, session.uploadToken, files, textItems, validityDays);
			setUploadResult(result.retrievalCode);
			setFiles([]);
			setTextItems([]);
		} catch (error) {
			console.error('Upload failed:', error);
			// Errors are shown by the progress component; a cancelled upload is not an error
		}
	};

	const handleUpload = () => runUpload(false);

	const handleRetry = () => runUpload(true);

	const handleCancel = () => {
		cancelUpload(sessionData?.sessionId, sessionData?.uploadToken);
		setSessionData(null);
		setUploadResult(null);
	};

	// Until the sign-in check finishes, the page shows nothing to upload with
	if (!authChecked) {
		return (
			<main className="min-h-screen bg-gray-50 py-8">
				<div className="max-w-2xl mx-auto px-4 text-center text-gray-600">{t('upload.checking')}</div>
			</main>
		);
	}

	// Signed out: only the sign-in methods that are switched on are offered; with none, nothing is uploadable
	if (!csrfToken) {
		return (
			<main className="min-h-screen bg-gray-50 py-8">
				<div className="max-w-md mx-auto px-4">
					<div className="text-center mb-8">
						<a href="/" className="text-blue-600 hover:text-blue-800 text-sm">
							← Back to Home
						</a>
						<h1 className="text-4xl font-bold text-gray-900 mt-4 mb-2">{t('upload.pageTitle')}</h1>
						<p className="text-lg text-gray-600">{t('upload.signInSubtitle')}</p>
						<div className="flex justify-center mt-2">
							<LanguageSwitcher />
						</div>
					</div>
					<div className="bg-white rounded-lg shadow-md p-8">
						{methods ? (
							<AuthMethodPicker
								status={methods}
								onSignedIn={(token) => {
									setCsrfToken(token);
									loadAuth();
								}}
							/>
						) : (
							<p className="text-gray-700">{t('upload.reachFailed')}</p>
						)}
					</div>
				</div>
			</main>
		);
	}

	if (uploadResult) {
		return (
			<main className="min-h-screen bg-gray-50 py-8">
				<div className="max-w-2xl mx-auto px-4">
					<div className="text-center mb-8">
						<a href="/" className="text-blue-600 hover:text-blue-800 text-sm">
							← Back to Home
						</a>
						<h1 className="text-4xl font-bold text-gray-900 mt-4 mb-2">{t('upload.resultTitle')}</h1>
					</div>

					<div className="bg-white rounded-lg shadow-md p-8">
						<div className="text-center">
							<div className="text-8xl mb-6">✅</div>
							<h2 className="text-3xl font-bold text-green-700 mb-4">{t('upload.resultHeading')}</h2>
							<p className="text-gray-600 mb-8 text-lg">{t('upload.resultBody')}</p>

							<ShareResult code={uploadResult} />

							<div className="space-y-3">
								<button
									onClick={() => {
										setUploadResult(null);
										clearError();
									}}
									className="w-full py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600 font-semibold"
								>
									{t('upload.shareMore')}
								</button>
								<a href="/" className="block w-full py-3 bg-gray-500 text-white rounded-lg hover:bg-gray-600 font-semibold text-center">
									Back to Home
								</a>
							</div>
						</div>
					</div>
				</div>
			</main>
		);
	}

	return (
		<main className="min-h-screen bg-gray-50 py-8">
			<div className="max-w-3xl mx-auto px-4">
				<div className="text-center mb-8">
					<a href="/" className="text-blue-600 hover:text-blue-800 text-sm">
						← Back to Home
					</a>
					<h1 className="text-4xl font-bold text-gray-900 mt-4 mb-2">{t('upload.pageTitle')}</h1>
					<p className="text-xl text-gray-600">{t('upload.subtitle')}</p>
					<div className="flex justify-center mt-2">
						<LanguageSwitcher />
					</div>
					<div className="flex justify-center gap-4 mt-4 text-sm">
						<button type="button" onClick={() => setShowSecurity(true)} className="text-blue-600 hover:text-blue-800 underline">
							{t('upload.security')}
						</button>
						<button type="button" onClick={signOut} className="text-gray-700 hover:text-gray-900 underline">
							{t('upload.signOut')}
						</button>
					</div>
					{signOutError && <p className="text-red-700 text-sm mt-2">{signOutError}</p>}
				</div>

				{startError && (
					<div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
						<div className="flex justify-between items-center">
							<p className="text-red-700">{startError}</p>
							<button onClick={() => setStartError(null)} className="text-red-500 hover:text-red-700">
								✕
							</button>
						</div>
					</div>
				)}

				{error && (
					<div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
						<div className="flex justify-between items-center">
							<p className="text-red-700">{error}</p>
							<button onClick={clearError} className="text-red-500 hover:text-red-700">
								✕
							</button>
						</div>
					</div>
				)}

				{/* Upload Progress */}
				<UploadProgress
					files={files}
					textItems={textItems}
					isUploading={isUploading}
					progress={uploadProgress}
					fileProgress={fileProgress}
					uploadStatus={uploadStatus}
					error={error || undefined}
					onRetry={handleRetry}
					onCancel={handleCancel}
				/>

				<div className="bg-white rounded-lg shadow-md p-8">
					<div className="space-y-8">
						{/* Text Section */}
						<div>
							<h2 className="text-2xl font-bold text-gray-900 mb-4">{t('upload.textSection')}</h2>
							<TextInput textItems={textItems} onTextItemsChange={setTextItems} />
						</div>

						{/* Files Section */}
						<div>
							<h2 className="text-2xl font-bold text-gray-900 mb-4">{t('upload.filesSection')}</h2>
							<FileUpload files={files} onFilesChange={setFiles} />
						</div>

						<ExpirySelector value={validityDays} onChange={setValidityDays} />

						<button
							onClick={handleUpload}
							disabled={isUploading || (files.length === 0 && textItems.length === 0)}
							className="w-full py-4 bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:bg-gray-300 disabled:cursor-not-allowed font-semibold text-lg"
						>
							{isUploading ? (
								<span className="flex items-center justify-center gap-2">
									<div className="animate-spin text-xl">⏳</div>
									{t('upload.uploadingShort')}
								</span>
							) : (
								t('upload.submit')
							)}
						</button>
					</div>
				</div>
			</div>
			{showSecurity && csrfToken && (
				<SecuritySettingsModal
					csrfToken={csrfToken}
					onRotated={(token) => setCsrfToken(token)}
					onClose={() => setShowSecurity(false)}
					onSignedOut={() => {
						setShowSecurity(false);
						setCsrfToken(null);
						setSessionData(null);
						loadAuth();
					}}
				/>
			)}
		</main>
	);
}
