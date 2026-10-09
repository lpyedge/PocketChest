import { runWithConcurrency } from './concurrency';
import {
	CreateChestResponse,
	UploadResponse,
	CompleteUploadResponse,
	RetrieveResponse,
	TextItem,
	ValidityDays,
	CreateMultipartUploadResponse,
	UploadPartResponse,
	UploadPart,
	MultipartUploadProgress,
	FileUploadProgress,
} from './types';

// The API is served by the same Worker as the frontend
const API_BASE_URL = '';

function abortError(): DOMException {
	return new DOMException('Upload cancelled', 'AbortError');
}

// Ties an XMLHttpRequest to an AbortSignal: aborting the signal aborts the request and rejects with AbortError
function bindXhrAbort(xhr: XMLHttpRequest, signal: AbortSignal | undefined, reject: (reason: unknown) => void): void {
	if (!signal) return;
	const onAbort = () => xhr.abort();
	if (signal.aborted) {
		reject(abortError());
		return;
	}
	signal.addEventListener('abort', onAbort, { once: true });
	xhr.addEventListener('abort', () => reject(abortError()));
}

export class PocketChestAPI {
	constructor(private baseUrl: string = API_BASE_URL) {}

	// Whether the owner is signed in, and the CSRF token that the signed-in session must echo on changes
	async getOwnerStatus(): Promise<{ authenticated: boolean; csrfToken?: string }> {
		const response = await fetch(`${this.baseUrl}/api/auth/session`);

		if (!response.ok) {
			throw new Error('Failed to check sign-in');
		}

		return response.json();
	}

	// Starts an upload session; only the signed-in owner can do this
	async createUploadSession(csrfToken: string): Promise<CreateChestResponse> {
		const response = await fetch(`${this.baseUrl}/api/upload-sessions`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-PocketChest-CSRF': csrfToken,
			},
			body: JSON.stringify({}),
		});

		if (!response.ok) {
			const error = (await response.json().catch(() => ({}))) as { error?: string };
			throw new Error(error.error || 'Failed to start upload');
		}

		return response.json();
	}

	async uploadContent(
		sessionId: string,
		uploadToken: string,
		files: File[],
		textItems: TextItem[],
		onProgress?: (progress: { loaded: number; total: number; percentage: number }) => void,
		onFileProgress?: (progress: FileUploadProgress[]) => void,
		signal?: AbortSignal,
	): Promise<UploadResponse> {
		signal?.throwIfAborted();
		const CHUNK_SIZE = 20 * 1024 * 1024; // 20MB: larger files use multipart upload
		const MAX_CONCURRENT_SMALL_FILES = 3;

		const textSizes = textItems.map((textItem) => new TextEncoder().encode(textItem.content).length);
		const totalSize = files.reduce((sum, file) => sum + file.size, 0) + textSizes.reduce((sum, size) => sum + size, 0);
		let completedSize = 0;

		// One progress entry per input item, in input order: files first, then text items
		const progress: FileUploadProgress[] = [
			...files.map((file, index) => ({
				localId: `file-${index}`,
				fileId: '',
				filename: file.name,
				uploadedBytes: 0,
				totalBytes: file.size,
				percentage: 0,
				isText: false,
				status: 'waiting' as const,
			})),
			...textItems.map((textItem, index) => ({
				localId: `text-${index}`,
				fileId: '',
				filename: textItem.filename || `text-${index + 1}.txt`,
				uploadedBytes: 0,
				totalBytes: textSizes[index],
				percentage: 0,
				isText: true,
				status: 'waiting' as const,
			})),
		];
		const fileEntry = (index: number) => progress[index];
		const textEntry = (index: number) => progress[files.length + index];

		const emitFileProgress = () => {
			onFileProgress?.(progress.map((entry) => ({ ...entry })));
		};

		const emitOverallProgress = () => {
			if (!onProgress) return;
			const inFlight = progress
				.filter((entry) => entry.status === 'uploading' || entry.status === 'finalizing')
				.reduce((sum, entry) => sum + entry.uploadedBytes, 0);
			const loaded = completedSize + inFlight;
			onProgress({
				loaded,
				total: totalSize,
				percentage: totalSize === 0 ? 100 : Math.round((loaded / totalSize) * 100),
			});
		};

		const fileIds: string[] = new Array(files.length);
		const textIds: string[] = new Array(textItems.length);
		const textNames: string[] = new Array(textItems.length);

		// Text items travel in one request, before any file
		if (textItems.length > 0) {
			textItems.forEach((_, index) => {
				textEntry(index).status = 'starting';
			});
			emitFileProgress();

			const result = await this.uploadContentRegular(sessionId, uploadToken, [], textItems, undefined, signal);
			if (result.uploadedFiles.length !== textItems.length) {
				throw new Error('Unexpected response while uploading text items');
			}

			textItems.forEach((_, index) => {
				const uploaded = result.uploadedFiles[index];
				const entry = textEntry(index);
				textIds[index] = uploaded.fileId;
				textNames[index] = uploaded.filename;
				entry.fileId = uploaded.fileId;
				entry.status = 'completed';
				entry.uploadedBytes = entry.totalBytes;
				entry.percentage = 100;
				completedSize += entry.totalBytes;
			});
			emitFileProgress();
			emitOverallProgress();
		}

		// Small files: a fixed pool of at most 3 concurrent requests; waits for all of them
		const smallIndexes = files.map((_, index) => index).filter((index) => files[index].size <= CHUNK_SIZE);
		const largeIndexes = files.map((_, index) => index).filter((index) => files[index].size > CHUNK_SIZE);
		const resultNames: string[] = new Array(files.length);

		await runWithConcurrency(smallIndexes, MAX_CONCURRENT_SMALL_FILES, async (index) => {
			signal?.throwIfAborted();
			const file = files[index];
			const entry = fileEntry(index);
			entry.status = 'starting';
			emitFileProgress();

			const result = await this.uploadContentRegular(
				sessionId,
				uploadToken,
				[file],
				[],
				(chunk) => {
					entry.status = chunk.percentage === 100 ? 'finalizing' : 'uploading';
					entry.uploadedBytes = Math.min(file.size, chunk.loaded);
					entry.percentage = file.size === 0 ? 100 : Math.round((entry.uploadedBytes / file.size) * 100);
					emitFileProgress();
					emitOverallProgress();
				},
				signal,
			);
			if (result.uploadedFiles.length !== 1) {
				throw new Error(`Unexpected response while uploading ${file.name}`);
			}

			fileIds[index] = result.uploadedFiles[0].fileId;
			resultNames[index] = result.uploadedFiles[0].filename;
			entry.fileId = fileIds[index];
			entry.status = 'completed';
			entry.uploadedBytes = file.size;
			entry.percentage = 100;
			completedSize += file.size;
			emitFileProgress();
			emitOverallProgress();
		});

		// Large files use multipart upload, one after another
		for (const index of largeIndexes) {
			const file = files[index];
			const entry = fileEntry(index);
			entry.status = 'starting';
			emitFileProgress();

			const result = await this.uploadLargeFile(
				sessionId,
				uploadToken,
				file,
				(chunk) => {
					entry.fileId = chunk.fileId;
					entry.uploadedBytes = chunk.uploadedBytes;
					entry.percentage = chunk.percentage;
					entry.status = chunk.percentage === 100 ? 'finalizing' : 'uploading';
					emitFileProgress();
					emitOverallProgress();
				},
				signal,
			);

			fileIds[index] = result.fileId;
			resultNames[index] = result.filename;
			entry.fileId = result.fileId;
			entry.status = 'completed';
			entry.uploadedBytes = file.size;
			entry.percentage = 100;
			completedSize += file.size;
			emitFileProgress();
			emitOverallProgress();
		}

		// Every input item must have produced exactly one file id before the caller may complete the upload
		const uploadedFiles = [
			...files.map((_, index) => ({ fileId: fileIds[index], filename: resultNames[index], isText: false })),
			...textItems.map((_, index) => ({ fileId: textIds[index], filename: textNames[index], isText: true })),
		];
		if (uploadedFiles.some((uploaded) => !uploaded.fileId)) {
			throw new Error('Upload incomplete: some files were not stored');
		}

		return { uploadedFiles };
	}

	private async uploadContentRegular(
		sessionId: string,
		uploadToken: string,
		files: File[],
		textItems: TextItem[],
		onProgress?: (progress: { loaded: number; total: number; percentage: number }) => void,
		signal?: AbortSignal,
	): Promise<UploadResponse> {
		const formData = new FormData();

		files.forEach((file) => {
			formData.append('files', file);
		});

		textItems.forEach((textItem) => {
			formData.append(
				'textItems',
				JSON.stringify({
					content: textItem.content,
					filename: textItem.filename || `text-${Date.now()}.txt`,
				}),
			);
		});

		// Use XMLHttpRequest for progress tracking if onProgress is provided
		if (onProgress) {
			return new Promise((resolve, reject) => {
				const xhr = new XMLHttpRequest();

				xhr.upload.addEventListener('progress', (event) => {
					if (event.lengthComputable) {
						const percentage = Math.round((event.loaded / event.total) * 100);
						onProgress({
							loaded: event.loaded,
							total: event.total,
							percentage,
						});
					}
				});

				xhr.addEventListener('load', () => {
					if (xhr.status >= 200 && xhr.status < 300) {
						try {
							const result = JSON.parse(xhr.responseText);
							resolve(result);
						} catch (error) {
							reject(new Error('Failed to parse response'));
						}
					} else {
						reject(new Error(`Upload failed with status ${xhr.status}`));
					}
				});

				xhr.addEventListener('error', () => {
					reject(new Error('Network error during upload'));
				});

				bindXhrAbort(xhr, signal, reject);
				xhr.open('POST', `${this.baseUrl}/api/upload-sessions/${sessionId}/files`);
				xhr.setRequestHeader('Authorization', `Bearer ${uploadToken}`);
				xhr.send(formData);
			});
		}

		// Fallback to fetch if no progress tracking needed
		const response = await fetch(`${this.baseUrl}/api/upload-sessions/${sessionId}/files`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${uploadToken}`,
			},
			body: formData,
			signal,
		});

		if (!response.ok) {
			throw new Error('Failed to upload files');
		}

		return response.json();
	}

	// Abandons an upload session on the server: its uploads stop and unfinished multipart uploads are aborted
	async cancelSession(sessionId: string, uploadToken: string): Promise<void> {
		const response = await fetch(`${this.baseUrl}/api/upload-sessions/${sessionId}/cancel`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${uploadToken}`,
			},
		});

		if (!response.ok) {
			throw new Error('Failed to cancel upload');
		}
	}

	async completeUpload(
		sessionId: string,
		uploadToken: string,
		fileIds: string[],
		validityDays: ValidityDays = 7,
	): Promise<CompleteUploadResponse> {
		const response = await fetch(`${this.baseUrl}/api/upload-sessions/${sessionId}/complete`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${uploadToken}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				fileIds,
				validityDays,
			}),
		});

		if (!response.ok) {
			throw new Error('Failed to complete upload');
		}

		return response.json();
	}

	// The code goes in the request body, so it never appears in a URL, a log line or a Referer
	async retrieveChest(retrievalCode: string, signal?: AbortSignal): Promise<RetrieveResponse> {
		const response = await fetch(`${this.baseUrl}/api/retrieve`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ code: retrievalCode }),
			signal,
		});

		if (!response.ok) {
			if (response.status === 404) {
				throw new Error('Retrieval code not found or expired');
			}
			if (response.status === 400) {
				throw new Error('Invalid retrieval code');
			}
			throw new Error('Failed to retrieve chest');
		}

		return response.json();
	}

	// Step 1 of a download: exchange the retrieval token for a download Cookie valid for this file only
	async authorizeDownload(fileId: string, chestToken: string): Promise<void> {
		const response = await fetch(`${this.baseUrl}/api/download/authorize`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${chestToken}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ fileId }),
		});

		if (!response.ok) {
			throw new Error('Download is not authorized');
		}
		await response.text();
	}

	// Small text items are read through the same two steps as a download
	async downloadTextContent(fileId: string, chestToken: string, signal?: AbortSignal): Promise<string> {
		await this.authorizeDownload(fileId, chestToken);
		const response = await fetch(`${this.baseUrl}/api/download/${fileId}`, { signal });

		if (!response.ok) {
			throw new Error('Failed to download text');
		}
		return response.text();
	}

	// Binary files are never read into memory: after authorizing, the browser streams the file itself
	async downloadFileDirectly(fileId: string, chestToken: string, filename: string): Promise<void> {
		await this.authorizeDownload(fileId, chestToken);

		const link = document.createElement('a');
		link.href = `${this.baseUrl}/api/download/${fileId}`;
		link.download = filename;
		document.body.appendChild(link);
		link.click();
		document.body.removeChild(link);
	}

	// Multipart upload methods
	async createMultipartUpload(
		sessionId: string,
		uploadToken: string,
		filename: string,
		mimeType: string,
		fileSize: number,
	): Promise<CreateMultipartUploadResponse> {
		const response = await fetch(`${this.baseUrl}/api/upload-sessions/${sessionId}/multipart/create`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${uploadToken}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				filename,
				mimeType,
				fileSize,
			}),
		});

		if (!response.ok) {
			throw new Error('Failed to create multipart upload');
		}

		return response.json();
	}

	async uploadPart(
		sessionId: string,
		multipartToken: string,
		fileId: string,
		partNumber: number,
		data: ArrayBuffer,
		onPartProgress?: (loaded: number, total: number) => void,
		signal?: AbortSignal,
	): Promise<UploadPartResponse> {
		// Use XMLHttpRequest for progress tracking
		if (onPartProgress) {
			return new Promise((resolve, reject) => {
				const xhr = new XMLHttpRequest();

				xhr.upload.addEventListener('progress', (event) => {
					if (event.lengthComputable) {
						onPartProgress(event.loaded, event.total);
					}
				});

				xhr.addEventListener('load', () => {
					if (xhr.status >= 200 && xhr.status < 300) {
						try {
							const result = JSON.parse(xhr.responseText);
							resolve(result);
						} catch (error) {
							reject(new Error('Failed to parse response'));
						}
					} else {
						reject(new Error(`Failed to upload part ${partNumber} with status ${xhr.status}`));
					}
				});

				xhr.addEventListener('error', () => {
					reject(new Error(`Network error during part ${partNumber} upload`));
				});

				bindXhrAbort(xhr, signal, reject);
				xhr.open('PUT', `${this.baseUrl}/api/upload-sessions/${sessionId}/multipart/${fileId}/parts/${partNumber}`);
				xhr.setRequestHeader('Authorization', `Bearer ${multipartToken}`);
				xhr.setRequestHeader('Content-Type', 'application/octet-stream');
				xhr.send(data);
			});
		}

		// Fallback to fetch if no progress tracking needed
		const response = await fetch(`${this.baseUrl}/api/upload-sessions/${sessionId}/multipart/${fileId}/parts/${partNumber}`, {
			method: 'PUT',
			headers: {
				Authorization: `Bearer ${multipartToken}`,
				'Content-Type': 'application/octet-stream',
			},
			body: data,
			signal,
		});

		if (!response.ok) {
			throw new Error(`Failed to upload part ${partNumber}`);
		}

		return response.json();
	}

	async completeMultipartUpload(
		sessionId: string,
		multipartToken: string,
		fileId: string,
		parts: UploadPart[],
	): Promise<{ fileId: string; filename: string }> {
		const response = await fetch(`${this.baseUrl}/api/upload-sessions/${sessionId}/multipart/${fileId}/complete`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${multipartToken}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({ parts }),
		});

		if (!response.ok) {
			throw new Error('Failed to complete multipart upload');
		}

		return response.json();
	}

	async uploadLargeFile(
		sessionId: string,
		uploadToken: string,
		file: File,
		onProgress?: (progress: MultipartUploadProgress) => void,
		signal?: AbortSignal,
	): Promise<{ fileId: string; filename: string }> {
		const CHUNK_SIZE = 20 * 1024 * 1024; // 20MB chunks
		const totalParts = Math.ceil(file.size / CHUNK_SIZE);

		// Create multipart upload - uploadId is now a JWT token
		const { fileId, uploadId: multipartToken } = await this.createMultipartUpload(
			sessionId,
			uploadToken,
			file.name,
			file.type || 'application/octet-stream',
			file.size,
		);

		// Initial progress callback to transition from "starting" to "uploading"
		if (onProgress) {
			onProgress({
				fileId,
				filename: file.name,
				uploadedParts: 0,
				totalParts,
				uploadedBytes: 0,
				totalBytes: file.size,
				percentage: 0,
			});
		}

		const uploadedParts: UploadPart[] = [];

		// Upload parts with 3 concurrent uploads for better performance
		const concurrencyLimit = Math.min(3, totalParts);
		const partProgress = new Map<number, number>(); // Track progress of each part
		const completedPartSizes = new Map<number, number>(); // Track completed part sizes
		let completedPartsCount = 0;

		const calculateTotalProgress = () => {
			let totalUploaded = 0;

			// Add completed parts
			completedPartSizes.forEach((size) => {
				totalUploaded += size;
			});

			// Add in-progress parts (only if not already completed)
			partProgress.forEach((loaded, partNumber) => {
				if (!completedPartSizes.has(partNumber)) {
					totalUploaded += loaded;
				}
			});

			return totalUploaded;
		};

		// Upload parts in batches of 3 (or less for small files)
		for (let i = 0; i < totalParts; i += concurrencyLimit) {
			signal?.throwIfAborted();
			const batchPromises: Promise<void>[] = [];

			// Create batch of up to 3 concurrent uploads
			for (let j = 0; j < concurrencyLimit && i + j < totalParts; j++) {
				const partNumber = i + j + 1;
				const start = (partNumber - 1) * CHUNK_SIZE;
				const end = Math.min(start + CHUNK_SIZE, file.size);
				const chunk = file.slice(start, end);
				const chunkSize = chunk.size;

				const uploadPromise = (async () => {
					const arrayBuffer = await chunk.arrayBuffer();

					const result = await this.uploadPart(
						sessionId,
						multipartToken,
						fileId,
						partNumber,
						arrayBuffer,
						(loaded, total) => {
							// Update progress for this specific part
							partProgress.set(partNumber, loaded);

							// Calculate total progress atomically
							const totalUploaded = calculateTotalProgress();

							if (onProgress) {
								onProgress({
									fileId,
									filename: file.name,
									uploadedParts: completedPartsCount,
									totalParts,
									uploadedBytes: totalUploaded,
									totalBytes: file.size,
									percentage: Math.round((totalUploaded / file.size) * 100),
								});
							}
						},
						signal,
					);

					uploadedParts.push({
						partNumber,
						etag: result.etag,
					});

					// Atomically mark part as completed
					partProgress.delete(partNumber);
					completedPartSizes.set(partNumber, chunkSize);
					completedPartsCount++;

					// Update progress after completion
					if (onProgress) {
						const totalUploaded = calculateTotalProgress();

						onProgress({
							fileId,
							filename: file.name,
							uploadedParts: completedPartsCount,
							totalParts,
							uploadedBytes: totalUploaded,
							totalBytes: file.size,
							percentage: Math.round((totalUploaded / file.size) * 100),
						});
					}
				})();

				batchPromises.push(uploadPromise);
			}

			// Wait for this batch to complete before starting the next batch
			await Promise.all(batchPromises);
		}

		// All parts uploaded, now finalizing
		if (onProgress) {
			onProgress({
				fileId,
				filename: file.name,
				uploadedParts: totalParts,
				totalParts,
				uploadedBytes: file.size,
				totalBytes: file.size,
				percentage: 100,
			});
		}

		// Sort parts by part number and complete upload
		uploadedParts.sort((a, b) => a.partNumber - b.partNumber);
		const result = await this.completeMultipartUpload(sessionId, multipartToken, fileId, uploadedParts);

		return result;
	}
}
