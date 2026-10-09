// Retrieval codes: 6 characters, A-Z and 0-9 (must match the backend's isValidRetrievalCode)
const RETRIEVAL_CODE_PATTERN = /^[A-Z0-9]{6}$/;

export function normalizeRetrievalCode(value: string): string | null {
	const code = value.trim().toUpperCase();
	return RETRIEVAL_CODE_PATTERN.test(code) ? code : null;
}

// Reads the code from a fragment such as "#ABC123". Malformed percent-encoding is treated as no code.
export function parseCodeFromHash(hash: string): string | null {
	let decoded: string;
	try {
		decoded = decodeURIComponent(hash.replace(/^#/, ''));
	} catch {
		return null;
	}
	return normalizeRetrievalCode(decoded);
}

export function readCodeFromLocation(): string | null {
	return parseCodeFromHash(window.location.hash);
}

export function getRetrievePageUrl(): string {
	return `${window.location.origin}/retrieve/`;
}

export function getShareLink(code: string): string {
	return `${getRetrievePageUrl()}#${code}`;
}
