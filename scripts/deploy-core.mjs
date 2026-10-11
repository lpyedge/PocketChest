// Install and upgrade decision logic, shared by the three ways of deploying (Deploy Button build command, GitHub
// Actions, local `npm run deploy`). It has no network, file or process access of its own: the caller supplies a
// `runner` (what Cloudflare says about the target) and `files` (a place for the one-time secrets file).
//
// What it guarantees, and tests/deploy-installer.spec.ts checks with a fake runner:
//   - an installation is only treated as new when Cloudflare positively says so; any error or contradiction refuses
//   - a first install asks for nothing: it generates the root secret (JWT_SECRET) itself, and the Worker generates the
//     Owner password on first setup (auth/bootstrap.ts), so no password is typed, uploaded or prompted for here
//   - an upgrade or a resumed install uploads no secret: Worker secrets, the Owner and R2 stay exactly as they were
//   - a root secret is generated at most once per Worker, and never when an Owner already exists
//   - nothing is changed before every check has passed, and no secret value is ever returned, logged or put in an error

export const JWT_SECRET = 'JWT_SECRET';
// Set on older installations; the installer never sets it and never reads its value
export const SETUP_PASSWORD = 'ADMIN_BOOTSTRAP_PASSWORD';
// Set by the installer, only after the bucket was proven private: the Worker may then make the first Owner password
export const ARMED_SECRET = 'SETUP_ARMED';
export const OWNER_KEY = 'auth/owner.json';
export const MARKER_KEY = 'auth/bootstrap-marker';
// The one-time owner password, kept privately in the bucket until the owner changes it
export const INITIAL_PASSWORD_OBJECT = 'auth/initial-owner-password.txt';

export class DeployRefusal extends Error {
	constructor(code, message) {
		super(message);
		this.name = 'DeployRefusal';
		this.code = code;
	}
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
 * 'fresh'    nothing exists yet: make the root secret
 * 'resume'   a root secret exists but no Owner yet (an earlier install stopped): keep the root, finish the rest
 */
export function decide(state) {
	if (!state.bucketExists && (state.workerExists || state.hasRoot)) {
		throw new DeployRefusal(
			'bucket-missing',
			'The Worker exists but its R2 bucket does not, so this is not a fresh install. Nothing was changed. Check the bucket name in wrangler.jsonc.',
		);
	}
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
 * Inspect, decide, then (and only then) deploy.
 * `input`: { runner, files, workerName, bucketName, generateRoot, log }
 *   runner.createBucket(bucket)  -> makes an R2 bucket (only for a positively fresh target)
 *   runner.bucketPrivacy(bucket) -> { publicDevUrl: boolean, customDomains: number }, or throws when unclear
 *   files.write(object) -> path of a private temporary file holding the JSON; files.remove(path)
 *   generateRoot()      -> a fresh random secret
 */
export async function install(input) {
	const { runner, files, workerName, bucketName, generateRoot, log = () => undefined } = input;
	const state = await inspectTarget(runner, { workerName, bucketName });
	const mode = decide(state);

	if (mode === 'upgrade') {
		log('Upgrade: deploying the code only. Secrets, the Owner and the bucket are left as they are.');
		const outcome = await runner.deploy({ secretsFile: null, keepVars: true });
		return { mode, uploaded: [], url: outcome?.url ?? null };
	}

	// Fresh or resumed: a first Owner password may be made, so the bucket must be proven private before anything is armed
	const secrets = {};
	if (mode === 'fresh') secrets[JWT_SECRET] = generateRoot();
	secrets[ARMED_SECRET] = 'yes';

	if (!state.bucketExists) {
		try {
			await runner.createBucket(bucketName);
		} catch (error) {
			throw new DeployRefusal(
				'bucket-create-failed',
				`Could not create the R2 bucket "${bucketName}". Nothing was armed. ${describe(error)}`,
			);
		}
		if (!(await inspectTarget(runner, { workerName, bucketName })).bucketExists) {
			throw new DeployRefusal(
				'bucket-create-failed',
				`The R2 bucket "${bucketName}" does not show up after creating it. Nothing was armed.`,
			);
		}
	}
	const privacy = await attemptPrivacy(runner, bucketName);
	if (privacy.publicDevUrl !== false || privacy.customDomains !== 0) {
		throw new DeployRefusal(
			'bucket-not-private',
			`The R2 bucket "${bucketName}" can be reached without the Worker (public r2.dev access or a custom domain). Turn both off in the R2 dashboard, then run this again. Nothing was armed.`,
		);
	}

	log(
		mode === 'fresh'
			? 'First install: generating the root secret and arming first setup (uploaded together with the code). The Owner password is made by the site on first setup.'
			: 'Resuming an unfinished install: keeping the existing root secret and arming first setup.',
	);
	// The target is looked at again just before the change: two installs started together must not both create a root
	const again = await inspectTarget(runner, { workerName, bucketName });
	if (decide(again) !== mode || again.hasRoot !== state.hasRoot) {
		throw new DeployRefusal(
			'changed',
			'The Worker or bucket changed while this deploy was starting (another install?). Nothing was changed; run it again.',
		);
	}
	const path = await files.write(secrets);
	let outcome;
	try {
		outcome = await runner.deploy({ secretsFile: path, keepVars: false });
	} finally {
		await files.remove(path);
	}
	return { mode, uploaded: Object.keys(secrets), url: outcome?.url ?? null };
}

async function attemptPrivacy(runner, bucketName) {
	try {
		return await runner.bucketPrivacy(bucketName);
	} catch (error) {
		throw new DeployRefusal(
			'inspect-failed',
			`Could not confirm that the R2 bucket "${bucketName}" is private, so nothing was armed. ${describe(error)}`,
		);
	}
}

/**
 * Whether the installation really works: the sign-in page reports ready with the password method on, the Owner record
 * exists, and on a first setup the first password is still retrievable. After an owner password change that file is
 * removed on purpose, so an upgrade does not require it. `methods` is the parsed /api/auth/methods answer, or null when
 * it could not be read. Returns the problems; empty means ready.
 */
export function readinessVerdict({ methods, ownerExists, credentialExists, firstSetup }) {
	const problems = [];
	if (!methods) problems.push('the sign-in status could not be read from the Worker URL');
	else {
		if (methods.setup !== 'ready') problems.push(`the setup state is "${methods.setup}", not "ready"`);
		if (methods.methods?.password?.enabled !== true) problems.push('the password sign-in method is not enabled');
	}
	if (!ownerExists) problems.push(`the Owner record ${OWNER_KEY} is missing from the bucket`);
	if (firstSetup && !credentialExists)
		problems.push(
			`the first password object ${INITIAL_PASSWORD_OBJECT} is missing (retrieve it before it is gone, or sign in if you already changed it)`,
		);
	return problems;
}

/** The lines a person needs after a successful first install. Never contains a password. */
export function retrievalSteps({ url, bucketName }) {
	return [
		`Site: ${url}/upload/`,
		`Bucket: ${bucketName}`,
		`Your first Owner password is in the R2 bucket, object key: ${INITIAL_PASSWORD_OBJECT}`,
		'To read it: Cloudflare dashboard > R2 > open the bucket above > Objects > open that key > Download. Use it to sign in.',
		'Then change it in the site (Security settings). The stored copy is removed automatically after a successful change.',
	];
}
