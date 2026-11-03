#!/usr/bin/env node
// Prints the local owner password. Single source: .temp/auth/initial-owner-password.txt,
// which mirrors the R2 key auth/initial-owner-password.txt (only the root differs:
// bucket in production, .temp locally). Restores it from local R2 when the object is
// still there; otherwise explains what to do next.
//
// Usage: npm run password:local
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseJsonc } from './deploy-preflight-core.mjs';

const PASSWORD_FILE = '.temp/auth/initial-owner-password.txt';

const wranglerConfig = parseJsonc(readFileSync('wrangler.jsonc', 'utf8'));
const bucket = (wranglerConfig.r2_buckets ?? []).find((item) => item.binding === 'R2_STORAGE')?.bucket_name;
if (!bucket) throw new Error('wrangler.jsonc needs an R2_STORAGE bucket.');

// The file is only a convenience copy: local R2 is the single source of truth, exactly
// like production. Whatever is fetched is written back, and whatever cannot be fetched
// is removed, so the file is either current or absent — never stale, never empty.
let password = null;
for (let attempt = 0; attempt < 3 && !password; attempt++) {
	try {
		mkdirSync(dirname(PASSWORD_FILE), { recursive: true });
		execFileSync(
			'npx',
			['wrangler', 'r2', 'object', 'get', `${bucket}/auth/initial-owner-password.txt`, '--local', '--file', PASSWORD_FILE],
			{ stdio: 'pipe' },
		);
		const downloaded = readFileSync(PASSWORD_FILE, 'utf8').trim();
		if (downloaded) {
			chmodSync(PASSWORD_FILE, 0o600);
			password = downloaded;
		} else {
			rmSync(PASSWORD_FILE, { force: true });
		}
	} catch {
		// A failed download must not leave a 0-byte file behind: wrangler may create the
		// destination before it knows the object is missing, and an empty file would be
		// mistaken for a password on the next run.
		rmSync(PASSWORD_FILE, { force: true });
		if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1000));
	}
}
if (password) {
	console.log(password);
	process.exit(0);
}

let setup = null;
try {
	const response = await fetch('http://127.0.0.1:8787/api/auth/methods', { signal: AbortSignal.timeout(5000) });
	if (response.ok) setup = (await response.json()).setup;
} catch {
	// dev server is not running
}

if (setup === null) {
	console.error('No saved password and the dev server is not answering. Start it first: npm run preview');
	process.exit(1);
}
if (setup === 'ready') {
	console.error('The owner exists but the initial password was retired (it was changed).');
	console.error('Sign in with the password you set. Forgot it? Run `npm run preview -- --reset` for a fresh local owner.');
	process.exit(1);
}
console.error(`First setup is "${setup}". Open http://localhost:8787/upload/ once (or run npm run preview), then retry.`);
process.exit(1);
