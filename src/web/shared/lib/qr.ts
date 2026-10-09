import qrcode from 'qrcode-generator';

// Modules of white around the code that scanners need
export const QUIET_ZONE = 4;

/** The QR code for `value` as rows of dark (true) and light (false) modules. */
export function qrMatrix(value: string): boolean[][] {
	const qr = qrcode(0, 'M');
	qr.addData(value, 'Byte');
	qr.make();
	const count = qr.getModuleCount();
	return Array.from({ length: count }, (_, row) => Array.from({ length: count }, (_, column) => qr.isDark(row, column)));
}

/** The Base32 secret of an otpauth URI, plus a copy in groups of four for typing by hand. Null if there is none. */
export function totpSecretFrom(otpauthUri: string): { secret: string; grouped: string } | null {
	let secret: string | null;
	try {
		secret = new URL(otpauthUri).searchParams.get('secret');
	} catch {
		return null;
	}
	return secret ? { secret, grouped: (secret.match(/.{1,4}/g) ?? []).join(' ') } : null;
}
