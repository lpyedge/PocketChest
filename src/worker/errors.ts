// An error with a status, a stable code and a message that is safe to show to the client.
// Extra headers (such as Retry-After) are sent with the error response.
export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly headers: Record<string, string> = {},
	) {
		super(message);
	}
}
