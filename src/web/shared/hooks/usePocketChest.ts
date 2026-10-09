import { useState, useCallback } from 'react';
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
	const [uploadStatus, setUploadStatus] = useState<'idle' | 'uploading' | 'success' | 'error' | 'cancelled'>('idle');
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
				const result = await api.completeUpload(sessionId, uploadToken, fileIds, validityDays);

				setUploadStatus('success');
				setAbortController(null); // Clear abort controller on success

				return {
					...result,
					uploadedFiles,
				};
			} catch (err) {
				setAbortController(null);
				if (err instanceof DOMException && err.name === 'AbortError') {
					// The user cancelled: not an error, nothing was completed
					setUploadStatus('cancelled');
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

			setUploadStatus('idle');
			setError(null);
			setUploadProgress({ percentage: 0, loaded: 0, total: 0 });
			setFileProgress([]);

			return uploadWithSession(sessionId, uploadToken, files, textItems, validityDays);
		},
		[uploadWithSession, abortController],
	);

	const cancelUpload = useCallback(
		(sessionId?: string, uploadToken?: string) => {
			// Stop the requests in flight, then tell the server to abandon the session
			if (abortController) {
				abortController.abort();
				setAbortController(null);
			}
			if (sessionId && uploadToken) {
				api.cancelSession(sessionId, uploadToken).catch((error) => console.error('Cancel failed:', error));
			}

			setIsUploading(false);
			setUploadStatus('cancelled');
			setUploadProgress({ percentage: 0, loaded: 0, total: 0 });
			setFileProgress([]);
			setError(null);
		},
		[abortController, api],
	);

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
		fileProgress,
		clearError: () => setError(null),
	};
}
