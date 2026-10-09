import { describe, it, expect, vi, afterEach } from 'vitest';
import { PocketChestAPI } from '../../src/web/shared/lib/api';

function trackedRequests(options: { delay?: number } = {}) {
	const state = { started: 0, active: 0, signals: [] as (AbortSignal | undefined)[] };
	const spy = vi.spyOn(PocketChestAPI.prototype as any, 'uploadContentRegular').mockImplementation(async (...args: unknown[]) => {
		const [, , files, , , signal] = args as [string, string, File[], unknown, unknown, AbortSignal | undefined];
		state.started++;
		state.active++;
		state.signals.push(signal);
		try {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, options.delay ?? 20);
				signal?.addEventListener('abort', () => {
					clearTimeout(timer);
					reject(new DOMException('Upload cancelled', 'AbortError'));
				});
			});
			return { uploadedFiles: [{ fileId: `id-${state.started}`, filename: files[0]?.name ?? 'text', isText: files.length === 0 }] };
		} finally {
			state.active--;
		}
	});
	return { spy, state };
}

function files(count: number): File[] {
	return Array.from({ length: count }, (_, i) => new File([`${i}`], `f${i}.txt`));
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('cancelling an upload', () => {
	it('rejects with AbortError, starts no new request after the cancel, and never resolves as success', async () => {
		const { state } = trackedRequests({ delay: 30 });
		const api = new PocketChestAPI('');
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 5);

		const outcome = await api.uploadContent('session', 'token', files(10), [], undefined, undefined, controller.signal).then(
			() => 'resolved',
			(error: Error) => error.name,
		);

		expect(outcome).toBe('AbortError');
		expect(state.active).toBe(0);
		expect(state.started).toBeLessThanOrEqual(3);
	});

	it('passes the signal to every request it starts', async () => {
		const { state } = trackedRequests();
		const api = new PocketChestAPI('');
		const controller = new AbortController();

		await api.uploadContent('session', 'token', files(4), [], undefined, undefined, controller.signal);

		expect(state.signals).toHaveLength(4);
		expect(state.signals.every((signal) => signal === controller.signal)).toBe(true);
	});

	it('does not start any request when the signal is already aborted', async () => {
		const { state } = trackedRequests();
		const api = new PocketChestAPI('');
		const controller = new AbortController();
		controller.abort();

		await expect(api.uploadContent('session', 'token', files(3), [], undefined, undefined, controller.signal)).rejects.toMatchObject({
			name: 'AbortError',
		});
		expect(state.started).toBe(0);
	});

	it('aborts the underlying fetch when the signal fires', async () => {
		const received: (AbortSignal | undefined)[] = [];
		vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
			received.push((init as RequestInit).signal ?? undefined);
			return new Promise((_resolve, reject) => {
				(init as RequestInit).signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
			});
		});
		const api = new PocketChestAPI('');
		const controller = new AbortController();
		const pending = (api as any).uploadContentRegular('session', 'token', [new File(['x'], 'x.txt')], [], undefined, controller.signal);
		controller.abort();

		await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
		expect(received[0]).toBe(controller.signal);
	});

	it('calls xhr.abort() when the signal fires', async () => {
		const abort = vi.fn();
		class FakeXHR {
			upload = { addEventListener: () => undefined };
			status = 0;
			responseText = '';
			listeners: Record<string, () => void> = {};
			addEventListener(name: string, handler: () => void) {
				this.listeners[name] = handler;
			}
			open() {}
			setRequestHeader() {}
			send() {}
			abort() {
				abort();
				this.listeners.abort?.();
			}
		}
		vi.stubGlobal('XMLHttpRequest', FakeXHR);
		const api = new PocketChestAPI('');
		const controller = new AbortController();
		const pending = (api as any).uploadContentRegular(
			'session',
			'token',
			[new File(['x'], 'x.txt')],
			[],
			() => undefined,
			controller.signal,
		);
		controller.abort();

		await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
		expect(abort).toHaveBeenCalledTimes(1);
		vi.unstubAllGlobals();
	});
});
