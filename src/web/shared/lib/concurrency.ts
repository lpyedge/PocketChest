/**
 * Runs `worker` over `items` with at most `limit` items in flight.
 *
 * Resolves with results in input order, and only after every started item has settled.
 * After the first failure no further items are started; in-flight items are still awaited,
 * then the first error is rethrown.
 */
export async function runWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let nextIndex = 0;
	let failure = null as { error: unknown } | null;

	// A lane never rejects, so Promise.all below waits for every in-flight item to finish
	const runLane = async (): Promise<void> => {
		while (!failure && nextIndex < items.length) {
			const index = nextIndex++;
			try {
				results[index] = await worker(items[index], index);
			} catch (error) {
				failure ??= { error };
			}
		}
	};

	const laneCount = Math.min(limit, items.length);
	await Promise.all(Array.from({ length: laneCount }, runLane));

	if (failure) {
		throw failure.error;
	}
	return results;
}
