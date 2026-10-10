#!/usr/bin/env node
// Offline finish of an interrupted first setup: the setup marker exists, the owner record does not (the site then
// says the administrator must recover setup). Removes the marker so setup can run again; it creates no owner and
// needs no password. Run by the deployer from a machine that holds Cloudflare credentials; the Worker has no route
// to this.
//
//   node scripts/recover-bootstrap.mjs --bucket pocket-chest
//
// See docs/RECOVERY.md.
import { BOOTSTRAP_MARKER_KEY, OWNER_KEY, recoverBootstrap } from './recovery-core.mjs';
import { wranglerDelete, wranglerGet } from './recovery-io.mjs';

const USAGE = `Usage: node scripts/recover-bootstrap.mjs --bucket <r2-bucket>

Removes the setup marker when first setup was interrupted (marker present, no owner record), so setup can run again.
Needs wrangler to be logged in with access to the bucket. Pause the public sign-in pages during the run (docs/RECOVERY.md).`;

function parseArgs(argv) {
	const args = { bucket: null, help: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--bucket') args.bucket = argv[++i];
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

	const storage = {
		async hasMarker() {
			return wranglerGet(args.bucket, BOOTSTRAP_MARKER_KEY) !== null;
		},
		async readOwner() {
			const body = wranglerGet(args.bucket, OWNER_KEY);
			return body === null ? null : { body };
		},
		async clearMarker() {
			wranglerDelete(args.bucket, BOOTSTRAP_MARKER_KEY);
		},
	};

	await recoverBootstrap(storage);
	console.log('The setup marker was removed and no owner exists, so first setup can run again with the deployment setup password.');
}

main().catch((error) => {
	console.error(error.message);
	process.exitCode = 1;
});
