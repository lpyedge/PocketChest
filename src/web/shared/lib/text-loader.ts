import { runWithConcurrency } from './concurrency';
import { MessageKey } from '../i18n';
import { ClientError, messageKeyFor } from './errors';

// A share can hold up to 100 text items, but each one costs an authorization, and those are limited per minute.
// So only the first few are shown without being asked, a few at a time; the rest load on request.
export const AUTO_LOAD_TEXT_ITEMS = 10;
export const TEXT_LOAD_CONCURRENCY = 3;

export type TextState =
	| { status: 'idle' }
	| { status: 'loading' }
	| { status: 'loaded'; content: string }
	| { status: 'error'; messageKey: MessageKey; code?: string };

/**
 * Loads text items with at most TEXT_LOAD_CONCURRENCY requests in flight. A failure belongs to its own item
 * (reported through `onUpdate`) and never stops the others. Cancelling stops new requests and reports nothing.
 */
export async function loadTexts(
	ids: readonly string[],
	load: (id: string, signal: AbortSignal) => Promise<string>,
	signal: AbortSignal,
	onUpdate: (id: string, state: TextState) => void,
): Promise<void> {
	await runWithConcurrency(ids, TEXT_LOAD_CONCURRENCY, async (id) => {
		if (signal.aborted) return;
		onUpdate(id, { status: 'loading' });
		try {
			onUpdate(id, { status: 'loaded', content: await load(id, signal) });
		} catch (error) {
			if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return;
			onUpdate(id, { status: 'error', messageKey: messageKeyFor(error), code: error instanceof ClientError ? error.code : undefined });
		}
	});
}
