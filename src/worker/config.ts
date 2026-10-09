/**
 * Refuses to run with secrets that cannot be secret. `.dev.vars.example` names every secret with a
 * REPLACE_WITH_ value, and a deploy button may show those as defaults: a deployment that kept one would
 * be signing tokens, or letting the owner be created, with a string everyone can read in the repository.
 */
const PLACEHOLDER = /replace[-_]?with|change[-_]?me/i;

export const MIN_JWT_SECRET_LENGTH = 24;

export function isPlaceholder(value: string): boolean {
	return PLACEHOLDER.test(value);
}

/** What is wrong with the deployment's secrets, as a message that names the setting but never its value. */
export function configurationProblem(env: { JWT_SECRET?: string }): string | null {
	const secret = env.JWT_SECRET;
	if (typeof secret !== 'string' || secret.length < MIN_JWT_SECRET_LENGTH) {
		return `JWT_SECRET is missing or shorter than ${MIN_JWT_SECRET_LENGTH} characters`;
	}
	if (isPlaceholder(secret)) {
		return 'JWT_SECRET is still an example value';
	}
	return null;
}
