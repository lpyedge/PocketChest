import { useState, useCallback, useRef } from 'react';
import { PocketChestAPI } from '@/lib/api';
import { TextItem, ValidityDays, FileUploadProgress } from '@/lib/types';
import { messageKeyFor } from '@/lib/errors';
import { useI18n } from '@/i18n/I18nProvider';

export function usePocketChest() {
	const { t } = useI18n();
	const [isUploading, setIsUploading] = useState(false);
	const [isRetrieving, setIsRetrieving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [uploadProgress, setUploadProgress] = useState({ percentage: 0, loaded: 0, total: 0 });
	const [uploadStatus, setUploadStatus] = useState<'idle' | 'uploading' | 'cancelling' | 'success' | 'error' | 'cancelled'>('idle');
	// True from the moment the share is being completed: it cannot be taken back from then on
	const [isFinalizing, setIsFinalizing] = useState(false);
	// Everything uploaded, Complete not answered yet. Asking again for the same session is safe and gives the same code;
	// uploading again under a new session would make a second share.
	const pendingCompletion = useRef<{ sessionId: string; uploadToken: string; fileIds: string[]; validityDays: ValidityDays } | null>(null);
	const [fileProgress, setFileProgress] = useState<FileUploadProgress[]>([]);
	const [abortController, setAbortController] = useState<AbortController | null>(null);

	const api = new PocketChestAPI();

	const retrieve = useCallback(
		async (retrievalCode: string, signal?: AbortSignal) => {
			setIsRetrieving(true);
			setError(null);

			try {
				const { files, chestToken, expiryDate } = await api.retrieveChest(retrievalCode, signal);

				// Only the list is fetched here. Text content is read afterwards, a few items at a time (see lib/text-loader):
				// each item needs its own authorization, and a share can hold many of them
				return {
					files,
					expiryDate,
					chestToken,
				};
			} catch (err) {
				// A retrieval replaced by another code is not an error for the user
				if (err instanceof DOMException && err.name === 'AbortError') {
					throw err;
				}
				// Shown in the current language; the original error is passed on so its code stays available
				setError(t(messageKeyFor(err)));
				throw err;
			} finally {
				setIsRetrieving(false);
			}
		},
		[api],
	);

	// One text item. Its failure belongs to that item, so it is not shown as the page's error
	const loadText = useCallback(
		(fileId: string, chestToken: string, signal: AbortSignal) => api.downloadTextContent(fileId, chestToken, signal),
		[api],
	);

	const downloadSingleFile = useCallback(
		async (fileId: string, chestToken: string, filename: string) => {
			try {
				await api.downloadFileDirectly(fileId, chestToken, filename);
			} catch (err) {
				// Shown in the current language; the original error is passed on so its code stays available
				setError(t(messageKeyFor(err)));
				throw err;
			}
		},
		[api],
	);

	// Completing is not abortable: once it is sent, only its answer can say whether the share exists
	const finishCompletion = useCallback(
		async (pending: { sessionId: string; uploadToken: string; fileIds: string[]; validityDays: ValidityDays }) => {
			setIsFinalizing(true);
			try {
				const result = await api.completeUpload(pending.sessionId, pending.uploadToken, pending.fileIds, pending.validityDays);
				pendingCompletion.current = null;
				return result;
			} finally {
				setIsFinalizing(false);
			}
		},
		[api],
	);

	const uploadWithSession = useCallback(
		async (sessionId: string, uploadToken: string, files: File[], textItems: TextItem[], validityDays: ValidityDays = 7) => {
			// Create new abort controller for this upload session
			const controller = new AbortController();
			setAbortController(controller);

			setIsUploading(true);
			setUploadStatus('uploading');
			setError(null);
			setUploadProgress({ percentage: 0, loaded: 0, total: 0 });
			setFileProgress([]);

			try {
				let finalProgress = { percentage: 0, loaded: 0, total: 0 };

				const { uploadedFiles } = await api.uploadContent(
					sessionId,
					uploadToken,
					files,
					textItems,
					(progress) => {
						finalProgress = progress;
						setUploadProgress(progress);
					},
					(fileProgressList) => {
						setFileProgress(fileProgressList);
					},

					controller.signal,
				);

				// Upload complete, now finalizing
				setUploadProgress({ percentage: 100, loaded: finalProgress.total, total: finalProgress.total });

				const fileIds = uploadedFiles.map((f) => f.fileId);
				pendingCompletion.current = { sessionId, uploadToken, fileIds, validityDays };
				const result = await finishCompletion(pendingCompletion.current);

				setUploadStatus('success');
				setAbortController(null); // Clear abort controller on success

				return {
					...result,
					uploadedFiles,
				};
			} catch (err) {
				setAbortController(null);
				if (err instanceof DOMException && err.name === 'AbortError') {
					// Stopped on purpose: not an error. What the page shows is decided by cancelUpload, once the
					// server has answered, so that "cancelled" is never shown before it is true
					throw err;
				}
				setError(t(messageKeyFor(err)));
				setUploadStatus('error');
				throw err;
			} finally {
				setIsUploading(false);
			}
		},
		[api],
	);

	const retryUpload = useCallback(
		async (sessionId: string, uploadToken: string, files: File[], textItems: TextItem[], validityDays: ValidityDays = 7) => {
			// Reset state completely before retry
			if (abortController) {
				abortController.abort();
				setAbortController(null);
			}

			// Everything is already uploaded and only the answer to Complete is missing: ask again, same session
			const waiting = pendingCompletion.current;
			if (waiting && waiting.sessionId === sessionId) {
				setError(null);
				setUploadStatus('uploading');
				setIsUploading(true);
				try {
					const result = await finishCompletion(waiting);
					setUploadStatus('success');
					return { ...result, uploadedFiles: waiting.fileIds.map((fileId) => ({ fileId, filename: '', isText: false })) };
				} catch (err) {
					setError(t(messageKeyFor(err)));
					setUploadStatus('error');
					throw err;
				} finally {
					setIsUploading(false);
				}
			}

			setUploadStatus('idle');
			setError(null);
			setUploadProgress({ percentage: 0, loaded: 0, total: 0 });
			setFileProgress([]);

			return uploadWithSession(sessionId, uploadToken, files, textItems, validityDays);
		},
		[uploadWithSession, finishCompletion, abortController],
	);

	// Resolves true only when the server has confirmed that the session is abandoned. A share that is being
	// completed cannot be cancelled, and a cancel the server refuses is reported instead of shown as done.
	const cancelUpload = useCallback(
		async (sessionId?: string, uploadToken?: string): Promise<boolean> => {
			if (isFinalizing) return false;
			// Stop the requests in flight, then ask the server to abandon the session
			if (abortController) {
				abortController.abort();
				setAbortController(null);
			}
			setUploadStatus('cancelling');
			try {
				if (sessionId && uploadToken) {
					await api.cancelSession(sessionId, uploadToken);
				}
			} catch (err) {
				console.error('Cancel failed:', err);
				// Not cancelled for certain: the upload may still be completed, so it is offered again (same session)
				setError(t('progress.cancelFailed'));
				setUploadStatus('error');
				setIsUploading(false);
				return false;
			}
			pendingCompletion.current = null;
			setIsUploading(false);
			setUploadStatus('cancelled');
			setUploadProgress({ percentage: 0, loaded: 0, total: 0 });
			setFileProgress([]);
			setError(null);
			return true;
		},
		[abortController, api, isFinalizing],
	);

	const hasPendingCompletion = useCallback((sessionId: string) => pendingCompletion.current?.sessionId === sessionId, []);

	return {
		uploadWithSession,
		retryUpload,
		cancelUpload,
		retrieve,
		loadText,
		downloadSingleFile,
		isUploading,
		isRetrieving,
		error,
		uploadProgress,
		uploadStatus,
		isFinalizing,
		hasPendingCompletion,
		fileProgress,
		clearError: () => setError(null),
	};
}
