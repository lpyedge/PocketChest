import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { resetStorage, setupTestEnvironment, createTestSession, testFetch } from './utils/test-setup';

const original = env.R2_STORAGE;
const bucket = () => original;

type PutHook = (key: string) => void | Promise<void>;

// Runs `fn` with a bucket that reports every put of a file object (`{session}/{file}`) to `hook`
async function withPutHook<T>(hook: PutHook, fn: () => Promise<T>): Promise<T> {
	const proxied = new Proxy(original, {
		get(target, property) {
			if (property === 'put') {
				return async (key: string, ...rest: unknown[]) => {
					if (/^[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(key)) await hook(key);
					return (target.put as any).call(target, key, ...rest);
				};
			}
			const value = (target as any)[property];
			return typeof value === 'function' ? value.bind(target) : value;
		},
	}) as R2Bucket;
	Object.defineProperty(env, 'R2_STORAGE', { value: proxied, configurable: true });
	try {
		return await fn();
	} finally {
		Object.defineProperty(env, 'R2_STORAGE', { value: original, configurable: true });
	}
}

function upload(sessionId: string, uploadToken: string, formData: FormData) {
	return testFetch(`http://example.com/api/upload-sessions/${sessionId}/files`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${uploadToken}` },
		body: formData,
	});
}

function text(name: string): string {
	return JSON.stringify({ content: name, filename: `${name}.txt` });
}

async function fileObjects(sessionId: string): Promise<string[]> {
	return (await bucket().list({ prefix: `${sessionId}/` })).objects.map((o) => o.key);
}

describe('FIX-05 uploads check everything before the first write', () => {
	beforeEach(async () => {
		await resetStorage();
		await setupTestEnvironment();
	});

	it('refuses 101 items over the file quota without starting a single write', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const form = new FormData();
		for (let i = 0; i < 101; i++) form.append('textItems', text(`t${i}`));
		const puts: string[] = [];

		const response = await withPutHook(
			(key) => void puts.push(key),
			() => upload(sessionId, uploadToken, form),
		);

		expect(response.status).toBe(413);
		await response.text();
		expect(puts).toEqual([]);
		expect(await fileObjects(sessionId)).toEqual([]);
	});

	it('refuses a request whose last text item is malformed without starting any write', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const form = new FormData();
		form.append('textItems', text('good1'));
		form.append('textItems', text('good2'));
		form.append('textItems', '{not json');
		const puts: string[] = [];

		const response = await withPutHook(
			(key) => void puts.push(key),
			() => upload(sessionId, uploadToken, form),
		);

		expect(response.status).toBe(400);
		await response.text();
		expect(puts).toEqual([]);
	});

	it('refuses a body above the request limit when no Content-Length is declared, with a 413', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const form = new FormData();
		const chunk = new Uint8Array(18 * 1024 * 1024);
		for (let i = 0; i < 4; i++) form.append('files', new File([chunk], `big${i}.bin`));
		const puts: string[] = [];

		const response = await withPutHook(
			(key) => void puts.push(key),
			() => upload(sessionId, uploadToken, form),
		);

		expect(response.status).toBe(413);
		await response.text();
		expect(puts).toEqual([]);
	});

	it('removes what an interrupted upload wrote, and frees the session for the next upload', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const form = new FormData();
		for (const name of ['a', 'b', 'c']) form.append('textItems', text(name));
		let seen = 0;

		const response = await withPutHook(
			() => {
				if (++seen === 2) throw new Error('injected R2 failure');
			},
			() => upload(sessionId, uploadToken, form),
		);

		expect(response.status).toBe(500);
		await response.text();
		expect(await fileObjects(sessionId)).toEqual([]);

		const retry = new FormData();
		retry.append('textItems', text('again'));
		const ok = await upload(sessionId, uploadToken, retry);
		expect(ok.status).toBe(200);
		await ok.text();
		expect(await fileObjects(sessionId)).toHaveLength(1);
	});

	it('still stores a normal mixed upload', async () => {
		const { sessionId, uploadToken } = await createTestSession();
		const form = new FormData();
		form.append('files', new File(['hello'], 'hello.txt'));
		form.append('textItems', text('note'));

		const response = await upload(sessionId, uploadToken, form);

		expect(response.status).toBe(200);
		expect(((await response.json()) as any).uploadedFiles).toHaveLength(2);
		expect(await fileObjects(sessionId)).toHaveLength(2);
	});
});
