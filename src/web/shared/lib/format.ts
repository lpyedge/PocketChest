// File sizes in binary units (1 KiB = 1024 bytes), named as such. `labels` carries the translated "bytes" words.
const UNITS = ['KiB', 'MiB', 'GiB', 'TiB'];

export function formatBytes(bytes: number, locale: string, labels: { zero: string; bytes: string }): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return labels.zero;
	const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length);
	const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(bytes / 1024 ** power);
	return `${number} ${power === 0 ? labels.bytes : UNITS[power - 1]}`;
}
