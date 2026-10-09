// Multipart sizing. These numbers mirror the Worker's limits (src/worker/limits.ts); a test keeps them equal.
// Every part has the same size, so the largest file that can be finished is PART_BYTES * MAX_PARTS.
const MiB = 1024 * 1024;

export const PART_BYTES = 20 * MiB;
export const MAX_PARTS = 10000;
export const MAX_MULTIPART_FILE_BYTES = PART_BYTES * MAX_PARTS;

/** How a file is split, or null when it would need more parts than R2 allows. */
export function planParts(size: number): { partBytes: number; totalParts: number } | null {
	const totalParts = Math.ceil(size / PART_BYTES);
	return totalParts > MAX_PARTS ? null : { partBytes: PART_BYTES, totalParts };
}
