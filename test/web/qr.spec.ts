import { describe, it, expect } from 'vitest';
import jsQR from 'jsqr';
import { qrMatrix, QUIET_ZONE, totpSecretFrom } from '../../src/web/shared/lib/qr';

// Draws the matrix as the page does (a quiet zone around it) and reads it back with an independent decoder
function decode(modules: boolean[][], scale = 6): string | null {
	const size = (modules.length + QUIET_ZONE * 2) * scale;
	const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
	modules.forEach((row, r) =>
		row.forEach((dark, c) => {
			if (!dark) return;
			for (let y = 0; y < scale; y++) {
				for (let x = 0; x < scale; x++) {
					const at = (((r + QUIET_ZONE) * scale + y) * size + (c + QUIET_ZONE) * scale + x) * 4;
					pixels[at] = pixels[at + 1] = pixels[at + 2] = 0;
				}
			}
		}),
	);
	return jsQR(pixels, size, size)?.data ?? null;
}

const URI = 'otpauth://totp/PocketChest:owner?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=PocketChest&algorithm=SHA1&digits=6&period=30';

describe('FIX-11 authenticator QR code', () => {
	it('encodes exactly the otpauth URI, so an authenticator app reads the same seed', () => {
		expect(decode(qrMatrix(URI))).toBe(URI);
	});

	it('is a square matrix with the three finder patterns', () => {
		const modules = qrMatrix(URI);
		expect(modules.every((row) => row.length === modules.length)).toBe(true);
		expect(modules[0].slice(0, 7).every(Boolean)).toBe(true);
		expect(modules[0].slice(-7).every(Boolean)).toBe(true);
		expect(modules[modules.length - 1].slice(0, 7).every(Boolean)).toBe(true);
	});

	it('reads the Base32 secret back out of the URI, grouped for typing by hand', () => {
		expect(totpSecretFrom(URI)).toEqual({ secret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP', grouped: 'JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP' });
		expect(totpSecretFrom('not a uri')).toBeNull();
		expect(totpSecretFrom('otpauth://totp/x?issuer=y')).toBeNull();
	});
});
