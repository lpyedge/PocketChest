import { describe, it, expect } from 'vitest';
import { createDownloadJWT, createUploadJWT, verifyChestJWT, verifyDownloadJWT, verifyUploadJWT } from '../src/worker/utils';

const SECRET = 'jwt-claims-test-secret';
const enc = new TextEncoder();
const b64 = (value: string | Uint8Array) =>
	btoa(typeof value === 'string' ? value : String.fromCharCode(...value))
		.replace(/=+$/, '')
		.replace(/\+/g, '-')
		.replace(/\//g, '_');

// A token signed with the right secret but with whatever header and payload the test wants: only the claims are at issue
async function signed(header: unknown, payload: unknown, secret = SECRET): Promise<string> {
	const message = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(payload))}`;
	const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	return `${message}.${b64(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message))))}`;
}

const HEADER = { alg: 'HS256', typ: 'JWT' };
const now = () => Math.floor(Date.now() / 1000);
const upload = (extra: object = {}) => ({ sessionId: 's', type: 'upload', iat: now(), exp: now() + 600, ...extra });

describe('R13 token claims are checked, not only the signature', () => {
	it('accepts the tokens the service itself issues', async () => {
		await expect(verifyUploadJWT(await createUploadJWT('s', SECRET), SECRET)).resolves.toMatchObject({ type: 'upload' });
		const download = await createDownloadJWT({ sessionId: 's', code: 'ABC123', fileId: 'f' }, SECRET);
		await expect(verifyDownloadJWT(download, SECRET)).resolves.toMatchObject({ type: 'download' });
		await expect(verifyUploadJWT(await signed(HEADER, upload()), SECRET)).resolves.toBeTruthy();
	});

	it('refuses a header that is not HS256 / JWT, even when the signature is valid', async () => {
		for (const header of [
			{ alg: 'none', typ: 'JWT' },
			{ alg: 'HS512', typ: 'JWT' },
			{ alg: 'HS256' },
			{ alg: 'HS256', typ: 'JWE' },
			{},
			[],
			null,
			'text',
		]) {
			await expect(verifyUploadJWT(await signed(header, upload()), SECRET), JSON.stringify(header)).rejects.toThrow();
		}
	});

	it('refuses a token with no expiry, or a non-integer, text, or past expiry', async () => {
		const withoutExp = { sessionId: 's', type: 'upload', iat: now() };
		for (const payload of [
			withoutExp,
			upload({ exp: '9999999999' }),
			upload({ exp: 1.5 }),
			upload({ exp: null }),
			upload({ exp: now() - 1 }),
			upload({ exp: 0 }),
		]) {
			await expect(verifyUploadJWT(await signed(HEADER, payload), SECRET), JSON.stringify(payload)).rejects.toThrow();
		}
	});

	it('refuses a token with a missing or invalid issue time, or one issued in the future', async () => {
		const withoutIat = { sessionId: 's', type: 'upload', exp: now() + 600 };
		for (const payload of [withoutIat, upload({ iat: '1' }), upload({ iat: 1.5 }), upload({ iat: now() + 3600 })]) {
			await expect(verifyUploadJWT(await signed(HEADER, payload), SECRET), JSON.stringify(payload)).rejects.toThrow();
		}
	});

	it('refuses a payload that is not an object', async () => {
		for (const payload of [[], null, 'upload', 7]) {
			await expect(verifyUploadJWT(await signed(HEADER, payload), SECRET)).rejects.toThrow();
		}
	});

	it('refuses wrong secrets, other token types, and malformed tokens', async () => {
		await expect(verifyUploadJWT(await signed(HEADER, upload(), 'another-secret'), SECRET)).rejects.toThrow();
		await expect(verifyChestJWT(await signed(HEADER, upload()), SECRET)).rejects.toThrow();
		for (const token of ['', 'a.b', 'a.b.c.d', '...', 'not base64!.x.y']) {
			await expect(verifyUploadJWT(token, SECRET), token).rejects.toThrow();
		}
	});
});
