// Install and upgrade decision logic, shared by the three ways of deploying (Deploy Button build command, GitHub
// Actions, local `npm run deploy`). It has no network, file or process access of its own: the caller supplies a
// `runner` (what Cloudflare says about the target) and `files` (a place for the one-time secrets file).
//
// What it guarantees, and tests/deploy-installer.spec.ts checks with a fake runner:
//   - an installation is only treated as new when Cloudflare positively says so; any error or contradiction refuses
//   - a first install asks for exactly one thing, the Owner password, and generates the root secret (JWT_SECRET) itself
//   - an upgrade never needs the password and never sends a secret: Worker secrets and R2 stay exactly as they were
//   - a root secret is generated at most once per Worker, and never when an Owner already exists
//   - nothing is changed before every check has passed, and no secret value is ever returned, logged or put in an error

const PLACEHOLDER = /replace[-_]?with|change[-_]?me/i;
export const MIN_PASSWORD_LENGTH = 16;
export const JWT_SECRET = 'JWT_SECRET';
export const SETUP_PASSWORD = 'ADMIN_BOOTSTRAP_PASSWORD';
export const OWNER_KEY = 'auth/owner.json';
export const MARKER_KEY = 'auth/bootstrap-marker';

export class DeployRefusal extends Error {
	constructor(code, message) {
		super(message);
		this.name = 'DeployRefusal';
		this.code = code;
	}
}

/** Why a first-install password is unusable, or null. Never repeats the value. */
export function passwordProblem(password) {
	if (typeof password !== 'string' || password.length === 0) return 'is missing';
	if (password.length < MIN_PASSWORD_LENGTH) return `is shorter than ${MIN_PASSWORD_LENGTH} characters`;
	if (PLACEHOLDER.test(password)) return 'is still an example value';
	return null;
}

/**
 * Reads, never writes. `runner`:
 *   secretNames(worker)      -> string[] of the Worker's secret names, or null when the Worker does not exist yet
 *   bucketExists(bucket)     -> boolean
 *   objectExists(bucket,key) -> boolean (only asked when the bucket exists)
 * Any of them may throw; that is reported as a refusal, never read as "absent".
 */
export async function inspectTarget(runner, { workerName, bucketName }) {
	const attempt = async (what, action) => {
		try {
			return await action();
		} catch (error) {
			throw new DeployRefusal('inspect-failed', `Could not check ${what}, so nothing was changed. ${describe(error)}`);
		}
	};
	const secrets = await attempt(`the Worker "${workerName}"`, () => runner.secretNames(workerName));
	const bucketExists = await attempt(`the R2 bucket "${bucketName}"`, () => runner.bucketExists(bucketName));
	const ownerExists = bucketExists ? await attempt('the Owner record', () => runner.objectExists(bucketName, OWNER_KEY)) : false;
	const markerExists = bucketExists ? await attempt('the setup marker', () => runner.objectExists(bucketName, MARKER_KEY)) : false;
	const names = new Set(secrets ?? []);
	return {
		workerExists: secrets !== null,
		bucketExists,
		hasRoot: names.has(JWT_SECRET),
		hasSetupPassword: names.has(SETUP_PASSWORD),
		ownerExists,
		markerExists,
	};
}

/**
 * 'upgrade'  the installation is complete: deploy the code only
 * 'fresh'    nothing exists yet: make the root secret and set the Owner password
 * 'resume'   a root secret exists but no Owner yet (an earlier install stopped): keep the root, finish the rest
 */
export function decide(state) {
	if (state.markerExists && !state.ownerExists) {
		throw new DeployRefusal(
			'recovery-required',
			'First setup was started on this bucket but never finished (a setup marker exists and no Owner). Nothing was changed. Recover it first: see docs/RECOVERY.md.',
		);
	}
	if (state.ownerExists) {
		if (!state.hasRoot) {
			throw new DeployRefusal(
				'root-missing',
				'This bucket already has an Owner, but the Worker has no JWT_SECRET. A new one would lock the Owner out, so nothing was changed. Check that the Worker name and Cloudflare account are the ones this installation was made with.',
			);
		}
		return 'upgrade';
	}
	return state.hasRoot ? 'resume' : 'fresh';
}

const describe = (error) =>
	String(error?.message ?? error)
		.split('\n')[0]
		.slice(0, 200);

/**
 * Inspect, decide, check inputs, then (and only then) deploy.
 * `input`: { runner, files, workerName, bucketName, env, promptPassword, generateRoot, log }
 *   files.write(object) -> path of a private temporary file holding the JSON; files.remove(path)
 *   promptPassword() -> string | null (hidden input; null when there is no terminal)
 *   generateRoot()   -> a fresh random secret
 */
export async function install(input) {
	const { runner, files, workerName, bucketName, env = {}, promptPassword, generateRoot, log = () => undefined } = input;
	const state = await inspectTarget(runner, { workerName, bucketName });
	const mode = decide(state);

	// What has to be uploaded, decided and checked before anything is changed
	const secrets = {};
	if (mode === 'fresh') secrets[JWT_SECRET] = generateRoot();
	const needsPassword = mode !== 'upgrade' && !state.hasSetupPassword;
	let password = typeof env[SETUP_PASSWORD] === 'string' && env[SETUP_PASSWORD] !== '' ? env[SETUP_PASSWORD] : null;
	if (mode !== 'upgrade' && password !== null && passwordProblem(password)) {
		throw new DeployRefusal('password-invalid', `${SETUP_PASSWORD} ${passwordProblem(password)}. Nothing was changed.`);
	}
	if (needsPassword && password === null) password = (await promptPassword?.()) ?? null;
	if (needsPassword) {
		const problem = passwordProblem(password);
		if (problem) {
			throw new DeployRefusal(
				'password-required',
				`A first install needs the Owner password, and it ${problem}. Set ${SETUP_PASSWORD} (at least ${MIN_PASSWORD_LENGTH} characters) or run this in a terminal to type it. Nothing was changed.`,
			);
		}
	}
	if (mode !== 'upgrade' && password !== null && !passwordProblem(password)) secrets[SETUP_PASSWORD] = password;

	if (Object.keys(secrets).length === 0) {
		log(`Upgrade: deploying the code only. Secrets, the Owner and the bucket are left as they are.`);
		await runner.deploy({ secretsFile: null, keepVars: true });
		return { mode, uploaded: [] };
	}

	log(
		mode === 'fresh'
			? `First install: generating the root secret and setting the Owner password (uploaded together with the code).`
			: `Resuming an unfinished install: keeping the existing root secret, setting what is missing.`,
	);
	// The target is looked at again just before the change: two installs started together must not both create a root
	const again = await inspectTarget(runner, { workerName, bucketName });
	if (decide(again) !== mode || again.hasRoot !== state.hasRoot || again.hasSetupPassword !== state.hasSetupPassword) {
		throw new DeployRefusal(
			'changed',
			'The Worker or bucket changed while this deploy was starting (another install?). Nothing was changed; run it again.',
		);
	}
	const path = await files.write(secrets);
	try {
		await runner.deploy({ secretsFile: path, keepVars: false });
	} finally {
		await files.remove(path);
	}
	return { mode, uploaded: Object.keys(secrets) };
}
