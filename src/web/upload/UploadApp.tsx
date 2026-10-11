import { useState, useEffect, type ReactNode } from 'react';
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
import { AppHeader } from '@/components/AppHeader';
import { IconButton } from '@/components/IconButton';
import { CheckCircleIcon, HistoryIcon, UserIcon } from '@/components/Icons';
import { ShareHistoryModal } from '@/components/ShareHistoryModal';
import { useI18n } from '@/i18n/I18nProvider';
import { addHistory, clearHistory, expiryFromDays } from '@/lib/history';
import { ClientError, messageKeyFor } from '@/lib/errors';
import { TextItem, ValidityDays } from '@/lib/types';

export default function UploadApp() {
	const { t } = useI18n();
	const [files, setFiles] = useState<File[]>([]);
	const [text, setText] = useState('');
	const [validityDays, setValidityDays] = useState<ValidityDays>(7);
	const [uploadResult, setUploadResult] = useState<string | null>(null);
	const [sessionData, setSessionData] = useState<{ sessionId: string; uploadToken: string } | null>(null);

	// Owner sign-in: the CSRF token of the signed-in session, or null when nobody is signed in
	const [csrfToken, setCsrfToken] = useState<string | null>(null);
	const [authChecked, setAuthChecked] = useState(false);
	const [methods, setMethods] = useState<AuthMethodsStatus | null>(null);
	const [showSecurity, setShowSecurity] = useState(false);
	const [showHistory, setShowHistory] = useState(false);
	const [startError, setStartError] = useState<string | null>(null);

	useEffect(() => {
		document.title = t('upload.docTitle');
	}, [t]);

	const {
		uploadWithSession,
		retryUpload,
		cancelUpload,
		isUploading,
		isFinalizing,
		hasPendingCompletion,
		resetUpload,
		uploadProgress,
		uploadStatus,
		fileProgress,
		error,
		clearError,
	} = usePocketChest();
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

	// Text is one item: everything typed in the box, stored as a .txt file
	const buildTextItems = (): TextItem[] => (text.trim() ? [{ content: text, filename: `${t('text.defaultName')}.txt` }] : []);

	const finishShare = (code: string, textCount: number) => {
		const now = Date.now();
		addHistory({ code, createdAt: now, expiresAt: expiryFromDays(validityDays, now), files: files.length, texts: textCount }, now);
		setUploadResult(code);
		setFiles([]);
		setText('');
	};

	const runUpload = async (retry: boolean) => {
		const textItems = buildTextItems();
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

		// Only the answer to Complete was missing: ask again in the same session (it gives the same share), do not start over
		if (retry && sessionData && hasPendingCompletion(sessionData.sessionId)) {
			try {
				const result = await retryUpload(sessionData.sessionId, sessionData.uploadToken, files, textItems, validityDays);
				finishShare(result.retrievalCode, textItems.length);
			} catch (error) {
				console.error('Completing again failed:', error);
			}
			return;
		}

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
			finishShare(result.retrievalCode, textItems.length);
		} catch (error) {
			console.error('Upload failed:', error);
			// Errors are shown by the progress component; a cancelled upload is not an error
		}
	};

	const handleUpload = () => runUpload(false);

	const handleRetry = () => runUpload(true);

	const handleCancel = async () => {
		const cancelled = await cancelUpload(sessionData?.sessionId, sessionData?.uploadToken);
		if (cancelled) {
			setSessionData(null);
			setUploadResult(null);
		}
	};

	const shell = (icons: ReactNode, body: ReactNode) => (
		<div className="min-h-screen bg-gray-50">
			<AppHeader>{icons}</AppHeader>
			<main className="mx-auto max-w-2xl px-4 py-6">{body}</main>
		</div>
	);

	// Until the sign-in check finishes, the page shows nothing to upload with
	if (!authChecked) {
		return shell(null, <p className="py-12 text-center text-sm text-gray-600">{t('upload.checking')}</p>);
	}

	// Signed out: only the sign-in methods that are switched on are offered; with none, nothing is uploadable
	if (!csrfToken) {
		return shell(
			null,
			<div className="mx-auto max-w-md">
				<div className="mb-5 text-center">
					<h1 className="text-xl font-semibold text-gray-900">{t('upload.pageTitle')}</h1>
					<p className="mt-1 text-sm text-gray-600">{t('upload.signInSubtitle')}</p>
				</div>
				<div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
					{methods ? (
						<AuthMethodPicker
							status={methods}
							onSignedIn={(token) => {
								setCsrfToken(token);
								loadAuth();
							}}
						/>
					) : (
						<p className="text-sm text-gray-700">{t('upload.reachFailed')}</p>
					)}
				</div>
			</div>,
		);
	}

	const icons = (
		<>
			<IconButton label={t('nav.history')} onClick={() => setShowHistory(true)}>
				<HistoryIcon />
			</IconButton>
			<IconButton label={t('upload.security')} onClick={() => setShowSecurity(true)} align="right">
				<UserIcon />
			</IconButton>
		</>
	);

	const dialogs = (
		<>
			{showHistory && <ShareHistoryModal onClose={() => setShowHistory(false)} />}
			{showSecurity && (
				<SecuritySettingsModal
					csrfToken={csrfToken}
					onRotated={(token) => setCsrfToken(token)}
					onClose={() => setShowSecurity(false)}
					onSignedOut={() => {
						// The saved codes open shares: they do not stay behind on a browser that is signed out
						clearHistory();
						setShowSecurity(false);
						setCsrfToken(null);
						setSessionData(null);
						setUploadResult(null);
						loadAuth();
					}}
				/>
			)}
		</>
	);

	const title = (
		<div className="mb-5">
			<h1 className="text-xl font-semibold text-gray-900">{t('upload.pageTitle')}</h1>
			<p className="mt-1 text-sm text-gray-600">{t('upload.subtitle')}</p>
		</div>
	);

	if (uploadResult) {
		return (
			<>
				{shell(
					icons,
					<>
						{title}
						<section className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
							<div className="mb-5 flex items-center gap-2 text-green-700">
								<CheckCircleIcon width={22} height={22} />
								<h2 className="text-base font-semibold">{t('upload.resultHeading')}</h2>
							</div>
							<ShareResult code={uploadResult} />
							<button
								type="button"
								onClick={() => {
									setUploadResult(null);
									resetUpload();
								}}
								className="mt-6 w-full rounded-lg bg-blue-600 py-2.5 text-sm font-semibold text-white hover:bg-blue-700"
							>
								{t('upload.shareMore')}
							</button>
						</section>
					</>,
				)}
				{dialogs}
			</>
		);
	}

	const textItems = buildTextItems();
	const nothingToShare = files.length === 0 && textItems.length === 0;

	return (
		<>
			{shell(
				icons,
				<>
					{title}

					{startError && (
						<div className="mb-4 flex items-center justify-between rounded-lg border border-red-200 bg-red-50 p-3" role="alert">
							<p className="text-sm text-red-700">{startError}</p>
							<button onClick={() => setStartError(null)} aria-label={t('common.close')} className="text-red-500 hover:text-red-700">
								✕
							</button>
						</div>
					)}

					{error && (
						<div className="mb-4 flex items-center justify-between rounded-lg border border-red-200 bg-red-50 p-3">
							<p className="text-sm text-red-700">{error}</p>
							<button onClick={clearError} aria-label={t('common.close')} className="text-red-500 hover:text-red-700">
								✕
							</button>
						</div>
					)}

					<UploadProgress
						files={files}
						textItems={textItems}
						isUploading={isUploading}
						isFinalizing={isFinalizing}
						progress={uploadProgress}
						fileProgress={fileProgress}
						uploadStatus={uploadStatus}
						error={error || undefined}
						onRetry={handleRetry}
						onCancel={handleCancel}
					/>

					<section className="space-y-6 rounded-2xl bg-white p-6 shadow-sm ring-1 ring-gray-200">
						<FileUpload files={files} onFilesChange={setFiles} />
						<TextInput value={text} onChange={setText} />
						<ExpirySelector value={validityDays} onChange={setValidityDays} />

						<button
							onClick={handleUpload}
							disabled={isUploading || nothingToShare}
							className="w-full rounded-lg bg-blue-600 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300"
						>
							{isUploading ? t('upload.uploadingShort') : t('upload.submit')}
						</button>
					</section>
				</>,
			)}
			{dialogs}
		</>
	);
}
