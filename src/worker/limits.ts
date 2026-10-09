/**
 * Upload limits. Enforced by the Worker; the frontend mirrors them only to give early feedback.
 * Changing a number here changes what is accepted; keep docs/API.md in step.
 */
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

export const LIMITS = {
	// Files per upload session (regular and multipart together)
	maxFilesPerSession: 100,
	// Total bytes per upload session, counting stored files and reservations of uploads in progress
	maxSessionBytes: 200 * GiB,
	// A regular (non-multipart) file; larger files must use multipart upload
	maxSmallFileBytes: 20 * MiB,
	// Total body of one regular upload request (files and text items together)
	maxUploadRequestBytes: 64 * MiB,
	// One text item, in UTF-8 bytes
	maxTextBytes: 1 * MiB,
	// File name, in UTF-8 bytes
	maxFilenameBytes: 255,
	// One multipart part
	maxPartBytes: 20 * MiB,
	// One multipart file: every part but the last is maxPartBytes, so this is what the part limit can hold (about 195 GiB)
	maxMultipartFileBytes: 20 * MiB * 10000,
	// Parts per multipart upload (R2 limit)
	maxPartsPerUpload: 10000,
} as const;

export const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength;
