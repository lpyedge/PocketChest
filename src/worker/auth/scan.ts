/**
 * One batch of a cleanup pass over every object under `prefix`. The position is kept in R2, so a prefix
 * with more than `limit` objects is covered over several runs instead of re-reading its front each time.
 * `state.more` tells the caller that the pass is not finished yet.
 */
export interface ScanState {
	more: boolean;
}

export async function scanBatch(
	bucket: R2Bucket,
	prefix: string,
	limit: number,
	state: ScanState | undefined,
	visit: (key: string) => Promise<boolean>,
): Promise<number> {
	const cursorKey = `maintenance/scan-cursor/${prefix.replace(/\/$/, '').replace(/\//g, '-')}.json`;
	const saved = await bucket.get(cursorKey);
	let cursor: string | undefined;
	if (saved) {
		try {
			cursor = ((await saved.json()) as { cursor?: string | null }).cursor ?? undefined;
		} catch {
			cursor = undefined; // an unreadable position only means starting the pass again
		}
	}

	const page = await bucket.list({ prefix, cursor, limit });
	let removed = 0;
	for (const object of page.objects) {
		if (await visit(object.key)) removed++;
	}

	if (page.truncated) {
		await bucket.put(cursorKey, JSON.stringify({ cursor: page.cursor }), { httpMetadata: { contentType: 'application/json' } });
	} else if (saved) {
		await bucket.delete(cursorKey);
	}
	if (state) state.more = page.truncated;
	return removed;
}
