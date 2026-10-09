// Retrieval codes: 6 characters, A-Z and 0-9 (must match the backend's isValidRetrievalCode)
const RETRIEVAL_CODE_PATTERN = /^[A-Z0-9]{6}$/;

export function normalizeRetrievalCode(value: string): string | null {
	const code = value.trim().toUpperCase();
	return RETRIEVAL_CODE_PATTERN.test(code) ? code : null;
}

// Reads the code from /retrieve/#ABC123, falling back to the legacy /retrieve?code=ABC123
export function readCodeFromLocation(): string | null {
	const fromHash = decodeURIComponent(window.location.hash.slice(1));
	if (fromHash) {
		return normalizeRetrievalCode(fromHash);
	}

	const fromQuery = new URLSearchParams(window.location.search).get('code');
	return fromQuery ? normalizeRetrievalCode(fromQuery) : null;
}

export function getRetrievePageUrl(): string {
	return `${window.location.origin}/retrieve/`;
}

export function getShareLink(code: string): string {
	return `${getRetrievePageUrl()}#${code}`;
}
