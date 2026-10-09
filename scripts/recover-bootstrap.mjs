#!/usr/bin/env node
// Offline finish of an interrupted first setup: the setup marker exists, the owner record does not (the site then
// says the administrator must recover setup). Creates the first owner from a password you supply, and leaves the
// marker alone. Run by the deployer from a machine that holds Cloudflare credentials; the Worker has no route to this.
//
//   node scripts/recover-bootstrap.mjs --bucket pocket-chest
//   printf '%s' "$OWNER_PASSWORD" | node scripts/recover-bootstrap.mjs --bucket pocket-chest --password-stdin
//
// Use scripts/reset-owner-password.mjs when an owner already exists. See docs/RECOVERY.md.
import { OWNER_KEY, MIN_PASSWORD_LENGTH, recoverBootstrap } from './recovery-core.mjs';
import { readPassword, wranglerGet, wranglerPut } from './recovery-io.mjs';

const USAGE = `Usage: node scripts/recover-bootstrap.mjs --bucket <r2-bucket> [--password-stdin]

Creates the first owner when first setup was interrupted (setup marker present, no owner record).
Needs wrangler to be logged in with access to the bucket. Pause the public sign-in pages during the run (docs/RECOVERY.md).`;

function parseArgs(argv) {
	const args = { bucket: null, passwordStdin: false, help: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--bucket') args.bucket = argv[++i];
		else if (arg === '--password-stdin') args.passwordStdin = true;
		else if (arg === '--help' || arg === '-h') args.help = true;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	return args;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log(USAGE);
		return;
	}
	if (!args.bucket) {
		console.error(USAGE);
		process.exitCode = 2;
		return;
	}

	const password = await readPassword(args.passwordStdin, 'Owner password to set (input hidden): ');
	if (password.length < MIN_PASSWORD_LENGTH) {
		throw new Error(`The owner password must be at least ${MIN_PASSWORD_LENGTH} characters. Nothing was changed.`);
	}

	const storage = {
		async hasMarker() {
			return wranglerGet(args.bucket, 'auth/bootstrap-marker') !== null;
		},
		async readOwner() {
			const body = wranglerGet(args.bucket, OWNER_KEY);
			return body === null ? null : { body };
		},
		async writeOwner(body) {
			wranglerPut(args.bucket, OWNER_KEY, body);
		},
	};

	const result = await recoverBootstrap(storage, password);
	console.log(`The first owner was created and verified (authVersion ${result.authVersion}). The setup marker was left as it was.`);
	console.log('Sign in at /upload/ with this password, then set up an authenticator app or a passkey in Security settings.');
}

main().catch((error) => {
	console.error(error.message);
	process.exitCode = 1;
});
