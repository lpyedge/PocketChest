#!/usr/bin/env node
// Offline owner password reset. Run by the deployer during a maintenance window, from a machine that holds
// Cloudflare credentials. The Worker has no route to this; see docs/RECOVERY.md.
//
//   node scripts/reset-owner-password.mjs --bucket pocket-chest --backup ./owner-backup.json
//   printf '%s' "$NEW_PASSWORD" | node scripts/reset-owner-password.mjs --bucket pocket-chest --backup ./owner-backup.json --password-stdin
//
// The new password is read from a hidden prompt or from stdin, never from argv (so it stays out of shell history).
import { chmodSync, writeFileSync } from 'node:fs';
import { recoverPassword, OWNER_KEY, MIN_PASSWORD_LENGTH } from './recovery-core.mjs';
import { readPassword, wranglerGet, wranglerPut } from './recovery-io.mjs';

function parseArgs(argv) {
	const args = { bucket: null, backup: null, passwordStdin: false, help: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--bucket') args.bucket = argv[++i];
		else if (arg === '--backup') args.backup = argv[++i];
		else if (arg === '--password-stdin') args.passwordStdin = true;
		else if (arg === '--help' || arg === '-h') args.help = true;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	return args;
}

const USAGE = `Usage: node scripts/reset-owner-password.mjs --bucket <r2-bucket> --backup <file> [--password-stdin]

Resets the owner password from the command line. Needs wrangler to be logged in with access to the bucket.
Before running, pause the public sign-in pages for the maintenance window (see docs/RECOVERY.md).`;

// Storage through wrangler, with the deployer's credentials. Wrangler has no conditional write, which is why
// the core re-reads and compares before writing, and why the maintenance window must pause sign-in.
function wranglerStorage(bucket, backupPath) {
	return {
		async read() {
			const body = wranglerGet(bucket, OWNER_KEY);
			return body === null ? null : { body, etag: null };
		},
		async backup(body) {
			writeFileSync(backupPath, body, { mode: 0o600, flag: 'wx' });
			chmodSync(backupPath, 0o600);
		},
		async write(body) {
			wranglerPut(bucket, OWNER_KEY, body);
		},
	};
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		console.log(USAGE);
		return;
	}
	if (!args.bucket || !args.backup) {
		console.error(USAGE);
		process.exitCode = 2;
		return;
	}

	const password = await readPassword(args.passwordStdin, 'New owner password (input hidden): ');
	if (password.length < MIN_PASSWORD_LENGTH) {
		throw new Error(`The new password must be at least ${MIN_PASSWORD_LENGTH} characters. Nothing was changed.`);
	}

	const result = await recoverPassword(wranglerStorage(args.bucket, args.backup), password);
	console.log(`Password reset and verified. Owner authVersion is now ${result.authVersion}.`);
	console.log('Every existing owner session has ended. Sign in with the new password.');
	console.log(
		`Backup of the previous owner record: ${args.backup} (contains the old password hash; keep it private and delete it when done).`,
	);
}

main().catch((error) => {
	console.error(error.message);
	process.exitCode = 1;
});
