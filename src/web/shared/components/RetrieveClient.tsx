import { useState, useEffect, useRef } from 'react';
import { usePocketChest } from '@/hooks/usePocketChest';
import { FileInfo } from '@/lib/types';
import { describeExpiry } from '@/lib/expiry';
import { formatBytes } from '@/lib/format';
import { appUrl, homeUrlFor } from '@/lib/home';
import { LanguageSwitcher } from '@/components/LanguageSwitcher';
import { AUTO_LOAD_TEXT_ITEMS, loadTexts, TextState } from '@/lib/text-loader';
import { useI18n } from '@/i18n/I18nProvider';

type FileWithContent = FileInfo;

interface RetrieveClientProps {
	code: string;
	onBack?: () => void;
}

export function RetrieveClient({ code, onBack }: RetrieveClientProps) {
	const { t, locale } = useI18n();
	const [files, setFiles] = useState<FileWithContent[]>([]);
	const [expiryDate, setExpiryDate] = useState<string | null>(null);
	const [chestToken, setChestToken] = useState<string>('');
	const [copiedFileId, setCopiedFileId] = useState<string | null>(null);

	const { retrieve, loadText, downloadSingleFile, isRetrieving, error } = usePocketChest();
	// Requests made on demand, so switching to another code can cancel them as well
	const textControllers = useRef(new Set<AbortController>());
	const [texts, setTexts] = useState<Record<string, TextState>>({});

	// Each code is its own retrieval: switching codes aborts the previous request, and a response
	// that arrives late is dropped, so it can never replace the content of the current code
	useEffect(() => {
		const controller = new AbortController();
		setFiles([]);
		setExpiryDate(null);
		setChestToken('');
		setTexts({});

		retrieve(code, controller.signal)
			.then((result) => {
				if (controller.signal.aborted) return;
				setFiles(result.files);
				setExpiryDate(result.expiryDate);
				setChestToken(result.chestToken);
				// The first few text items appear by themselves; the others wait to be asked for
				const first = result.files.filter((file) => file.isText).slice(0, AUTO_LOAD_TEXT_ITEMS);
				void loadTexts(
					first.map((file) => file.fileId),
					(fileId, signal) => loadText(fileId, result.chestToken, signal),
					controller.signal,
					(fileId, next) => {
						if (!controller.signal.aborted) setTexts((current) => ({ ...current, [fileId]: next }));
					},
				);
			})
			.catch((err: unknown) => {
				if (!controller.signal.aborted) {
					console.error('Retrieval failed:', err);
				}
			});

		const onDemand = textControllers.current;
		return () => {
			controller.abort();
			onDemand.forEach((pending) => pending.abort());
			onDemand.clear();
		};
	}, [code]);

	// One text item on request, or again after it failed. Never affects the other items or the page
	const requestText = (fileId: string) => {
		const controller = new AbortController();
		textControllers.current.add(controller);
		void loadTexts(
			[fileId],
			(id, signal) => loadText(id, chestToken, signal),
			controller.signal,
			(id, next) => setTexts((current) => ({ ...current, [id]: next })),
		).finally(() => textControllers.current.delete(controller));
	};

	const handleDownload = async (file: FileWithContent) => {
		try {
			await downloadSingleFile(file.fileId, chestToken, file.filename);
		} catch (error) {
			console.error('Download failed:', error);
		}
	};

	const formatFileSize = (bytes: number): string => formatBytes(bytes, locale, { zero: t('size.zero'), bytes: t('size.bytes') });

	const copyTextToClipboard = (content: string, fileId: string) => {
		navigator.clipboard.writeText(content);
		setCopiedFileId(fileId);
		setTimeout(() => setCopiedFileId(null), 2000);
	};

	if (isRetrieving) {
		return (
			<main className="min-h-screen bg-gray-50 flex items-center justify-center">
				<div className="text-center">
					<div className="animate-spin text-4xl mb-4">⏳</div>
					<p className="text-xl">{t('retrieve.loading')}</p>
				</div>
			</main>
		);
	}

	if (error) {
		return (
			<main className="min-h-screen bg-gray-50 flex items-center justify-center">
				<div className="max-w-md mx-auto p-6 bg-white rounded-lg shadow-md text-center">
					<div className="flex justify-end mb-2">
						<LanguageSwitcher />
					</div>
					<div className="text-6xl mb-4">❌</div>
					<h1 className="text-2xl font-bold text-red-700 mb-2">{t('retrieve.failedTitle')}</h1>
					<p className="text-gray-600 mb-4">{error}</p>
					<button
						onClick={() => (window.location.href = homeUrlFor(locale))}
						className="px-6 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
					>
						{t('retrieve.goHome')}
					</button>
				</div>
			</main>
		);
	}

	return (
		<main className="min-h-screen bg-gray-50 py-8">
			<div className="max-w-4xl mx-auto px-4">
				<div className="flex justify-end mb-2">
					<LanguageSwitcher />
				</div>
				<div className="text-center mb-8">
					<h1 className="text-4xl font-bold text-gray-900 mb-2">PocketChest</h1>
					<p className="text-xl text-gray-600">
						{t('retrieve.codeLabel')} <code className="font-mono font-bold text-blue-600">{code}</code>
					</p>
				</div>

				{files.length > 0 && (
					<div className="space-y-8">
						{/* Text Content Section */}
						{files.some((f) => f.isText) && (
							<div className="bg-white rounded-lg shadow-md p-6">
								<h2 className="text-2xl font-bold text-gray-900 mb-4">{t('retrieve.textSection')}</h2>
								<div className="flex gap-4 overflow-x-auto pb-4">
									{files
										.filter((f) => f.isText)
										.map((file, index) => {
											// Remove .txt extension for display
											const displayName = file.filename.endsWith('.txt') ? file.filename.slice(0, -4) : file.filename;
											return (
												<div key={file.fileId} className="shrink-0 w-80 border border-gray-200 rounded-lg p-4">
													<h3 className="font-semibold text-lg text-gray-900 mb-2 truncate">{displayName}</h3>
													<p className="text-sm text-gray-500 mb-3">{formatFileSize(file.size)}</p>

													{(() => {
														const text = texts[file.fileId] ?? { status: 'idle' as const };
														if (text.status === 'loaded') {
															return (
																<div>
																	<div className="bg-gray-50 rounded p-3 max-h-40 overflow-y-auto mb-3">
																		<pre className="text-sm whitespace-pre-wrap font-mono">{text.content}</pre>
																	</div>
																	<div className="flex gap-2">
																		<button
																			onClick={() => copyTextToClipboard(text.content, file.fileId)}
																			className={`flex-1 text-xs px-3 py-2 rounded transition-colors ${
																				copiedFileId === file.fileId
																					? 'bg-green-500 text-white'
																					: 'bg-blue-500 text-white hover:bg-blue-600'
																			}`}
																		>
																			{copiedFileId === file.fileId ? t('retrieve.copied') : t('retrieve.copy')}
																		</button>
																		<button
																			onClick={() => handleDownload(file)}
																			className="flex-1 text-xs px-3 py-2 bg-green-500 text-white rounded hover:bg-green-600"
																		>
																			{t('retrieve.downloadTxt')}
																		</button>
																	</div>
																</div>
															);
														}
														if (text.status === 'loading') {
															return <p className="text-sm text-gray-500">{t('retrieve.loadingText')}</p>;
														}
														return (
															<div className="space-y-2">
																{text.status === 'error' && (
																	<p role="alert" className="text-sm text-red-700">
																		{t(text.messageKey)}
																	</p>
																)}
																<button
																	onClick={() => requestText(file.fileId)}
																	className="w-full text-xs px-3 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
																>
																	{text.status === 'error' ? t('retrieve.retryText') : t('retrieve.showText')}
																</button>
															</div>
														);
													})()}
												</div>
											);
										})}
								</div>
							</div>
						)}

						{/* Files Section */}
						{files.some((f) => !f.isText) && (
							<div className="bg-white rounded-lg shadow-md p-6">
								<div className="mb-6">
									<h2 className="text-2xl font-bold text-gray-900">
										{t('retrieve.filesSection', { count: files.filter((f) => !f.isText).length })}
									</h2>
									<p className="text-gray-600">{describeExpiry(expiryDate, locale, t)}</p>
								</div>

								<div className="space-y-4">
									{files
										.filter((f) => !f.isText)
										.map((file, index) => (
											<div key={file.fileId} className="border border-gray-200 rounded-lg p-4">
												<div className="flex items-center justify-between">
													<div className="flex-1 min-w-0">
														<h3 className="font-semibold text-lg text-gray-900 truncate">📄 {file.filename}</h3>
														<p className="text-sm text-gray-500">
															{t('retrieve.fileMeta', { size: formatFileSize(file.size), type: file.mimeType })}
														</p>
													</div>

													<div className="ml-4 shrink-0">
														<button
															onClick={() => handleDownload(file)}
															className="px-4 py-2 bg-green-500 text-white rounded hover:bg-green-600"
														>
															{t('retrieve.download')}
														</button>
													</div>
												</div>
											</div>
										))}
								</div>
							</div>
						)}
					</div>
				)}

				<div className="text-center space-x-4">
					{onBack && (
						<button onClick={onBack} className="px-6 py-2 bg-gray-500 text-white rounded-lg hover:bg-gray-600">
							{t('retrieve.enterAnother')}
						</button>
					)}
					<button
						onClick={() => (window.location.href = appUrl('/upload/', locale))}
						className="px-6 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
					>
						{t('retrieve.uploadFiles')}
					</button>
				</div>
			</div>
		</main>
	);
}
