import { useState, useEffect, useRef, type ReactNode } from 'react';
import { usePocketChest } from '@/hooks/usePocketChest';
import { FileInfo } from '@/lib/types';
import { describeExpiry } from '@/lib/expiry';
import { formatBytes } from '@/lib/format';
import { homeUrlFor } from '@/lib/home';
import { AppHeader } from '@/components/AppHeader';
import { IconButton } from '@/components/IconButton';
import { AlertIcon, CheckIcon, CopyIcon, DownloadIcon, FileIcon, KeyIcon } from '@/components/Icons';
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
		navigator.clipboard.writeText(content).catch(() => undefined);
		setCopiedFileId(fileId);
		setTimeout(() => setCopiedFileId(null), 2000);
	};

	const remainingMs = expiryDate === null ? null : Date.parse(expiryDate) - Date.now();
	const headerExpiryClass =
		remainingMs === null || Number.isNaN(remainingMs)
			? remainingMs === null
				? 'text-emerald-700'
				: 'text-gray-500'
			: remainingMs < 24 * 3600 * 1000
				? 'text-red-700'
				: remainingMs < 3 * 24 * 3600 * 1000
					? 'text-amber-700'
					: 'text-gray-500';

	const shell = (body: ReactNode) => (
		<div className="min-h-screen bg-gray-50">
			<AppHeader>
				<IconButton label={t('nav.enterCode')} onClick={() => onBack?.()} align="right">
					<KeyIcon />
				</IconButton>
			</AppHeader>
			<main className="mx-auto max-w-2xl px-4 py-6">{body}</main>
		</div>
	);

	if (isRetrieving) {
		return shell(
			<div className="py-16 text-center">
				<div className="mx-auto mb-3 h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-blue-600" />
				<p className="text-sm text-gray-600">{t('retrieve.loading')}</p>
			</div>,
		);
	}

	if (error) {
		return shell(
			<div className="mx-auto max-w-md rounded-2xl bg-white p-6 text-center shadow-sm ring-1 ring-gray-200">
				<AlertIcon width={36} height={36} className="mx-auto mb-3 text-red-600" />
				<h1 className="mb-2 text-lg font-semibold text-red-700">{t('retrieve.failedTitle')}</h1>
				<p className="mb-4 text-sm text-gray-600">{error}</p>
				<button
					onClick={() => (window.location.href = homeUrlFor(locale))}
					className="rounded-lg bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700"
				>
					{t('retrieve.goHome')}
				</button>
			</div>,
		);
	}

	return shell(
		<>
			<div className="mb-5">
				<h1 className="text-xl font-semibold text-gray-900">{t('retrieve.pageTitle')}</h1>
				<div className="mt-1 flex items-center justify-between gap-3">
					<p className="min-w-0 truncate text-sm text-gray-600">
						{t('retrieve.codeLabel')} <code className="font-mono font-semibold tracking-wider text-blue-700">{code}</code>
					</p>
					{files.length > 0 && (
						<p className={`shrink-0 text-xs font-semibold ${headerExpiryClass}`}>{describeExpiry(expiryDate, locale, t)}</p>
					)}
				</div>
			</div>

			{files.length > 0 && (
				<div className="space-y-5">
					{/* Files first: they are what most shares are about */}
					{files.some((f) => !f.isText) && (
						<section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-200">
							<h2 className="mb-3 text-base font-semibold text-gray-900">
								{t('retrieve.filesSection', { count: files.filter((f) => !f.isText).length })}
							</h2>

							<ul className="divide-y divide-gray-100">
								{files
									.filter((f) => !f.isText)
									.map((file) => (
										<li key={file.fileId} className="flex items-center gap-3 py-3">
											<FileIcon width={20} height={20} className="shrink-0 text-gray-400" />
											<div className="min-w-0 flex-1">
												<p className="truncate text-sm font-medium text-gray-900">{file.filename}</p>
												<p className="text-xs text-gray-500">
													{t('retrieve.fileMeta', { size: formatFileSize(file.size), type: file.mimeType })}
												</p>
											</div>
											<button
												onClick={() => handleDownload(file)}
												className="shrink-0 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
											>
												{t('retrieve.download')}
											</button>
										</li>
									))}
							</ul>
						</section>
					)}

					{files.some((f) => f.isText) && (
						<section className="rounded-2xl bg-white p-5 shadow-sm ring-1 ring-gray-200">
							<h2 className="mb-3 text-base font-semibold text-gray-900">{t('retrieve.textSection')}</h2>
							<div className="space-y-3">
								{files
									.filter((f) => f.isText)
									.map((file) => {
										// Remove .txt extension for display
										const displayName = file.filename.endsWith('.txt') ? file.filename.slice(0, -4) : file.filename;
										const text = texts[file.fileId] ?? { status: 'idle' as const };
										const copied = copiedFileId === file.fileId;
										const copyNow = () => {
											if (text.status === 'loaded') copyTextToClipboard(text.content, file.fileId);
										};
										return (
											<div key={file.fileId} className="rounded-xl border border-gray-200 p-3">
												<div className="mb-1.5 flex items-center gap-2">
													<h3 className="min-w-0 shrink truncate text-sm font-medium text-gray-900">{displayName}</h3>
													<span className="shrink-0 text-xs text-gray-500">{formatFileSize(file.size)}</span>
													<span className="flex-1" aria-hidden="true" />
													{text.status === 'loaded' && (
														<span className="-mr-1 flex shrink-0 items-center">
															<IconButton
																label={copied ? t('retrieve.copied') : t('retrieve.copy')}
																onClick={() => text.status === 'loaded' && copyTextToClipboard(text.content, file.fileId)}
																className="[--iconbtn-size:1.75rem]"
															>
																{copied ? <CheckIcon className="text-green-600" /> : <CopyIcon />}
															</IconButton>
															<IconButton
																label={t('retrieve.downloadTxt')}
																onClick={() => handleDownload(file)}
																className="[--iconbtn-size:1.75rem]"
															>
																<DownloadIcon />
															</IconButton>
														</span>
													)}
												</div>

												{text.status === 'loaded' && (
													<div
														role="button"
														tabIndex={0}
														onClick={copyNow}
														onKeyDown={(event) => {
															if (event.key === 'Enter' || event.key === ' ') {
																event.preventDefault();
																copyNow();
															}
														}}
														aria-label={copied ? t('retrieve.copied') : t('retrieve.copy')}
														title={copied ? t('retrieve.copied') : t('retrieve.copy')}
														className="relative cursor-pointer rounded-lg bg-gray-50 p-3 focus-visible:outline-2 focus-visible:outline-blue-500"
													>
														<pre className="max-h-60 overflow-y-auto whitespace-pre-wrap font-mono text-sm text-gray-900">
															{text.content}
														</pre>
														{copied && (
															<span
																aria-hidden="true"
																className="absolute inset-0 flex items-center justify-center rounded-lg bg-gray-900/60"
															>
																<span className="flex items-center gap-1.5 text-sm font-medium text-white">
																	<CheckIcon width={16} height={16} />
																	{t('retrieve.copied')}
																</span>
															</span>
														)}
													</div>
												)}
												{text.status === 'loading' && <p className="text-sm text-gray-500">{t('retrieve.loadingText')}</p>}
												{(text.status === 'idle' || text.status === 'error') && (
													<div className="space-y-2">
														{text.status === 'error' && (
															<p role="alert" className="text-sm text-red-700">
																{t(text.messageKey)}
															</p>
														)}
														<button
															onClick={() => requestText(file.fileId)}
															className="w-full rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
														>
															{text.status === 'error' ? t('retrieve.retryText') : t('retrieve.showText')}
														</button>
													</div>
												)}
											</div>
										);
									})}
							</div>
						</section>
					)}
				</div>
			)}
		</>,
	);
}
