#!/usr/bin/env node
// Offline owner password reset. Run by the deployer during a maintenance window, from a machine that holds
// Cloudflare credentials. The Worker has no route to this; see docs/RECOVERY.md.
//
//   node scripts/reset-owner-password.mjs --bucket pocket-chest --backup ./owner-backup.json
//   printf '%s' "$NEW_PASSWORD" | node scripts/reset-owner-password.mjs --bucket pocket-chest --backup ./owner-backup.json --password-stdin
//
// The new password is read from a hidden prompt or from stdin, never from argv (so it stays out of shell history).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoverPassword, OWNER_KEY, MIN_PASSWORD_LENGTH } from './recovery-core.mjs';

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

// Reads the password. With a terminal, keystrokes are read without echo; with a pipe, the first line is taken.
function readPassword(fromStdin) {
	if (fromStdin || !process.stdin.isTTY) {
		return new Promise((resolve, reject) => {
			let data = '';
			process.stdin.setEncoding('utf8');
			process.stdin.on('data', (chunk) => (data += chunk));
			process.stdin.on('end', () => resolve(data.split(/\r?\n/)[0]));
			process.stdin.on('error', reject);
		});
	}
	return new Promise((resolve, reject) => {
		const stdin = process.stdin;
		process.stdout.write('New owner password (input hidden): ');
		stdin.setRawMode(true);
		stdin.setEncoding('utf8');
		stdin.resume();
		let value = '';
		const finish = () => {
			stdin.setRawMode(false);
			stdin.pause();
			stdin.off('data', onData);
		};
		const onData = (chunk) => {
			for (const char of chunk) {
				if (char === '\r' || char === '\n') {
					finish();
					process.stdout.write('\n');
					resolve(value);
					return;
				}
				if (char === '\u0003') {
					finish();
					reject(new Error('Cancelled. Nothing was changed.'));
					return;
				}
				if (char === '\u007f' || char === '\b') {
					value = value.slice(0, -1);
				} else {
					value += char;
				}
			}
		};
		stdin.on('data', onData);
	});
}

// Storage through wrangler, with the deployer's credentials. Wrangler has no conditional write, which is why
// the core re-reads and compares before writing, and why the maintenance window must pause sign-in.
function wranglerStorage(bucket, backupPath, tempDir) {
	const key = `${bucket}/${OWNER_KEY}`;
	return {
		async read() {
			try {
				const body = execFileSync('npx', ['wrangler', 'r2', 'object', 'get', key, '--remote', '--pipe'], {
					encoding: 'utf8',
					stdio: ['ignore', 'pipe', 'pipe'],
				});
				return { body, etag: null };
			} catch (error) {
				const message = String(error.stderr ?? error.message);
				if (/not found|does not exist|10007|NoSuchKey/i.test(message)) return null;
				throw new Error(`Could not read the owner record: ${message.split('\n')[0]}`);
			}
		},
		async backup(body) {
			writeFileSync(backupPath, body, { mode: 0o600, flag: 'wx' });
			chmodSync(backupPath, 0o600);
		},
		async write(body) {
			const file = join(tempDir, 'owner.json');
			writeFileSync(file, body, { mode: 0o600 });
			execFileSync('npx', ['wrangler', 'r2', 'object', 'put', key, '--remote', '--file', file, '--content-type', 'application/json'], {
				stdio: ['ignore', 'inherit', 'inherit'],
			});
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

	const password = await readPassword(args.passwordStdin);
	if (password.length < MIN_PASSWORD_LENGTH) {
		throw new Error(`The new password must be at least ${MIN_PASSWORD_LENGTH} characters. Nothing was changed.`);
	}

	const tempDir = mkdtempSync(join(tmpdir(), 'pocketchest-recovery-'));
	try {
		const result = await recoverPassword(wranglerStorage(args.bucket, args.backup, tempDir), password);
		console.log(`Password reset and verified. Owner authVersion is now ${result.authVersion}.`);
		console.log('Every existing owner session has ended. Sign in with the new password.');
		console.log(
			`Backup of the previous owner record: ${args.backup} (contains the old password hash; keep it private and delete it when done).`,
		);
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error.message);
	process.exitCode = 1;
});
