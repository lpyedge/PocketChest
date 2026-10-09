// An error with a status, a stable code and a message that is safe to show to the client
export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}
