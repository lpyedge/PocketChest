#!/usr/bin/env node
// One command for installing and upgrading PocketChest on Cloudflare:  npm run deploy
//
//   First install   asks for the Owner password once (hidden), or reads ADMIN_BOOTSTRAP_PASSWORD; makes the root
//                   secret itself. Nothing else to type, generate or back up.
//   Upgrade         asks for nothing. Secrets, the Owner and the bucket are never touched.
//
// It checks what Cloudflare says about the Worker and bucket named in wrangler.jsonc first, and refuses (changing
// nothing) when the answer is unclear. See DEPLOYMENT.md.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DeployRefusal, install, MIN_PASSWORD_LENGTH } from './deploy-core.mjs';
import { parseJsonc } from './deploy-preflight-core.mjs';
import { secretFiles, wranglerRunner } from './deploy-wrangler.mjs';
import { readPassword } from './recovery-io.mjs';

async function main() {
	const config = parseJsonc(readFileSync('wrangler.jsonc', 'utf8'));
	const bucket = (config.r2_buckets ?? []).find((item) => item.binding === 'R2_STORAGE');
	if (!config.name || !bucket?.bucket_name) {
		throw new DeployRefusal('config', 'wrangler.jsonc needs a Worker name and an R2_STORAGE bucket. Nothing was changed.');
	}

	const result = await install({
		runner: wranglerRunner,
		files: secretFiles,
		workerName: config.name,
		bucketName: bucket.bucket_name,
		env: process.env,
		generateRoot: () => randomBytes(48).toString('base64'),
		log: (line) => console.log(line),
		// Only asked when it is needed, and only in a terminal; a build or CI run supplies ADMIN_BOOTSTRAP_PASSWORD instead
		promptPassword: async () =>
			process.stdin.isTTY ? await readPassword(false, `Owner password (at least ${MIN_PASSWORD_LENGTH} characters, input hidden): `) : null,
	});

	if (result.mode === 'upgrade') {
		console.log('Done. Your sign-in, Owner password and shares are unchanged.');
	} else {
		console.log('Done. Open /upload/ and sign in with the Owner password you set. The site asks for it only to sign in.');
	}
}

main().catch((error) => {
	console.error(error instanceof DeployRefusal ? `Refused (${error.code}): ${error.message}` : `Deploy failed: ${error.message}`);
	process.exitCode = 1;
});
