import { describe, it, expect, vi, afterEach } from 'vitest';
import { PocketChestAPI } from '../../src/web/shared/lib/api';

// A minimal XMLHttpRequest that records what the client does with it
class FakeXhr {
	static instances: FakeXhr[] = [];
	opened = false;
	sent = false;
	aborted = false;
	status = 0;
	responseText = '';
	upload = { addEventListener: () => undefined };
	private listeners = new Map<string, (() => void)[]>();
	constructor() {
		FakeXhr.instances.push(this);
	}
	addEventListener(type: string, listener: () => void) {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}
	open() {
		this.opened = true;
	}
	setRequestHeader() {}
	send() {
		this.sent = true;
	}
	abort() {
		if (!this.sent) return; // a request that was never sent has nothing to abort and fires no event
		this.aborted = true;
		this.fire('abort');
	}
	fire(type: string) {
		this.listeners.get(type)?.forEach((listener) => listener());
	}
}

afterEach(() => {
	vi.unstubAllGlobals();
	FakeXhr.instances = [];
});

const api = new PocketChestAPI('');
const uploadPart = (signal: AbortSignal) => api.uploadPart('s', 't', 'f', 1, new ArrayBuffer(4), () => undefined, signal);
const uploadFiles = (signal: AbortSignal) =>
	api.uploadContent('s', 't', [new File(['x'], 'x.txt')], [], () => undefined, undefined, signal);

describe('FIX-08 XHR uploads and AbortSignal', () => {
	for (const [name, start] of [
		['part upload', uploadPart],
		['file upload', uploadFiles],
	] as const) {
		it(`${name}: a signal that is already aborted sends nothing`, async () => {
			vi.stubGlobal('XMLHttpRequest', FakeXhr);
			const controller = new AbortController();
			controller.abort();

			const outcome = await (start as typeof uploadPart)(controller.signal).then(
				() => 'resolved',
				(error: Error) => error.name,
			);

			expect(outcome).toBe('AbortError');
			expect(FakeXhr.instances.every((xhr) => !xhr.opened && !xhr.sent)).toBe(true);
		});

		it(`${name}: aborting after send aborts the request and rejects once`, async () => {
			vi.stubGlobal('XMLHttpRequest', FakeXhr);
			const controller = new AbortController();
			const pending = (start as typeof uploadPart)(controller.signal).then(
				() => 'resolved',
				(error: Error) => error.name,
			);
			await vi.waitFor(() => expect(FakeXhr.instances[0]?.sent).toBe(true));
			controller.abort();

			expect(await pending).toBe('AbortError');
			expect(FakeXhr.instances[0].aborted).toBe(true);
		});

		it(`${name}: removes its listener from the signal once the request has finished`, async () => {
			vi.stubGlobal('XMLHttpRequest', FakeXhr);
			const controller = new AbortController();
			const removed = vi.spyOn(controller.signal, 'removeEventListener');
			const pending = (start as typeof uploadPart)(controller.signal);
			await vi.waitFor(() => expect(FakeXhr.instances[0]?.sent).toBe(true));
			const xhr = FakeXhr.instances[0];
			xhr.status = 200;
			xhr.responseText = '{"etag":"e","partNumber":1,"uploadedFiles":[{"fileId":"id","filename":"x.txt","isText":false}]}';
			xhr.fire('load');
			xhr.fire('loadend');
			await pending;

			expect(removed).toHaveBeenCalledWith('abort', expect.any(Function));
		});
	}
});
