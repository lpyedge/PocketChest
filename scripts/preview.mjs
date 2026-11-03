#!/usr/bin/env node
// Local preview with zero manual setup: ensures .dev.vars, builds, starts wrangler dev,
// waits for boot, triggers first setup through /api/auth/methods, then copies the generated
// owner password from local R2 into .temp/auth/initial-owner-password.txt (mode 600) and prints it.
// The local path mirrors the R2 key auth/initial-owner-password.txt; only the root differs
// (bucket -> .temp). Sign in with it once, then change it in Security settings; the object
// is retired afterwards.
//
// Usage: npm run preview                       normal start, keeps the current owner
//        npm run preview -- --reset            forget the local owner and start over with a fresh
//                                             password (owner sessions and passkeys are cleared;
//                                             shares, files and codes are untouched)
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { parseJsonc } from './deploy-preflight-core.mjs';

const PORT = 8787;
const METHODS_URL = `http://127.0.0.1:${PORT}/api/auth/methods`;
const PASSWORD_FILE = '.temp/auth/initial-owner-password.txt';
// The previous location; removed once the canonical one is written so there is only one copy.
const LEGACY_PASSWORD_FILE = '.temp/owner-password.txt';

const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' });

const wranglerConfig = parseJsonc(readFileSync('wrangler.jsonc', 'utf8'));
const bucket = (wranglerConfig.r2_buckets ?? []).find((item) => item.binding === 'R2_STORAGE')?.bucket_name;
if (!bucket) throw new Error('wrangler.jsonc needs an R2_STORAGE bucket. Nothing was started.');

// Never overwrites an existing .dev.vars; also covered by the prepreview hook
run('node', ['scripts/setup-local.mjs', '--if-missing']);

if (process.argv.includes('--reset')) {
	console.log('Resetting the local owner: sessions and passkeys are cleared, shares/files/codes stay.');
	for (const key of ['auth/owner.json', 'auth/bootstrap-marker', 'auth/initial-owner-password.txt']) {
		try {
			execFileSync('npx', ['wrangler', 'r2', 'object', 'delete', `${bucket}/${key}`, '--local'], { stdio: 'pipe' });
		} catch {
			// absent is fine; first setup recreates what it needs
		}
	}
	rmSync(PASSWORD_FILE, { force: true });
	rmSync(LEGACY_PASSWORD_FILE, { force: true });
}

run('npm', ['run', 'build']);
mkdirSync('.temp', { recursive: true });

// Self-heal: `wrangler r2 object get <bucket>/<key> --local` without --file/--pipe materializes the key path
// locally, and an old hint printed that bare form. Only this exact file is ours at the repo root, so only it goes.
try {
	rmSync('auth/initial-owner-password.txt', { force: true });
	if (readdirSync('auth').length === 0) rmSync('auth', { recursive: true });
} catch {
	// absent is fine
}

const child = spawn('npx', ['wrangler', 'dev', '--port', String(PORT)], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, () => {
		child.kill(signal);
	});
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let setup = null;
for (let attempt = 0; attempt < 120; attempt++) {
	try {
		const response = await fetch(METHODS_URL);
		if (response.ok) {
			setup = (await response.json()).setup;
			break;
		}
	} catch {
		// not up yet
	}
	await sleep(1000);
}
if (setup === null) {
	console.error(`The Worker did not answer ${METHODS_URL}; stopping the dev server.`);
	child.kill('SIGTERM');
	process.exit(1);
}

// The request above already ran first setup when armed. Fetch what it generated.
// An empty or missing download counts as a failure: the stale branch below then removes
// any leftover file instead of leaving a 0-byte one behind.
let fetched = false;
for (let attempt = 0; attempt < 10 && !fetched; attempt++) {
	try {
		execFileSync(
			'npx',
			['wrangler', 'r2', 'object', 'get', `${bucket}/auth/initial-owner-password.txt`, '--local', '--file', PASSWORD_FILE],
			{ stdio: 'pipe' },
		);
		if (readFileSync(PASSWORD_FILE, 'utf8').trim()) {
			fetched = true;
		} else {
			rmSync(PASSWORD_FILE, { force: true });
		}
	} catch {
		rmSync(PASSWORD_FILE, { force: true });
		await sleep(1000);
	}
}
if (fetched && existsSync(PASSWORD_FILE)) {
	chmodSync(PASSWORD_FILE, 0o600);
	rmSync(LEGACY_PASSWORD_FILE, { force: true });
	const password = readFileSync(PASSWORD_FILE, 'utf8').trim();
	console.log('');
	console.log(`Owner password for this local run: ${password}`);
	console.log(`Also saved (mode 600) in ${PASSWORD_FILE}. Sign in with it once, then change it in Security settings.`);
} else if (setup === 'ready') {
	// The object is gone while an owner exists: the password was changed and the initial one retired.
	// A leftover file from an earlier state would no longer sign in, so both copies go.
	rmSync(PASSWORD_FILE, { force: true });
	rmSync(LEGACY_PASSWORD_FILE, { force: true });
	console.log('This local run already has an owner and no initial password object; sign in with the password you set.');
	console.log('Forgot it? Run `npm run preview -- --reset` for a fresh local owner and password.');
} else {
	console.log(`First setup state is "${setup}". Once it is ready, read the owner password with:`);
	console.log(`  npx wrangler r2 object get ${bucket}/auth/initial-owner-password.txt --local --pipe`);
}
