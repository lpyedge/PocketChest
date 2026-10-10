// Input and storage helpers shared by the offline recovery tools. Everything goes through wrangler with the
// deployer's own credentials; the Worker has no route to any of this.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Reads the password. With a terminal, keystrokes are read without echo; with a pipe, the first line is taken.
// It never comes from argv, so it stays out of shell history.
export function readPassword(fromStdin, prompt = 'Password (input hidden): ') {
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
		process.stdout.write(prompt);
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

const NOT_FOUND = /not found|does not exist|10007|NoSuchKey/i;

/** The object's text, or null when it does not exist. Other failures are errors, never "absent". */
export function wranglerGet(bucket, key) {
	try {
		return execFileSync('npx', ['wrangler', 'r2', 'object', 'get', `${bucket}/${key}`, '--remote', '--pipe'], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
	} catch (error) {
		const message = String(error.stderr ?? error.message);
		if (NOT_FOUND.test(message)) return null;
		throw new Error(`Could not read ${key}: ${message.split('\n')[0]}`);
	}
}

/** Deletes an object. Like put, it is not conditional: callers check just before and pause sign-in meanwhile. */
export function wranglerDelete(bucket, key) {
	execFileSync('npx', ['wrangler', 'r2', 'object', 'delete', `${bucket}/${key}`, '--remote'], { stdio: ['ignore', 'inherit', 'inherit'] });
}

/** Writes an object. wrangler has no conditional write, so callers check just before and pause sign-in meanwhile. */
export function wranglerPut(bucket, key, body) {
	const dir = mkdtempSync(join(tmpdir(), 'pocketchest-recovery-'));
	try {
		const file = join(dir, 'object.json');
		writeFileSync(file, body, { mode: 0o600 });
		execFileSync(
			'npx',
			['wrangler', 'r2', 'object', 'put', `${bucket}/${key}`, '--remote', '--file', file, '--content-type', 'application/json'],
			{
				stdio: ['ignore', 'inherit', 'inherit'],
			},
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
