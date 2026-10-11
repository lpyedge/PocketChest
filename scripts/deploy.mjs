#!/usr/bin/env node
// One command for installing and upgrading PocketChest on Cloudflare:  npm run deploy
//
//   First install   asks for nothing: makes the root secret itself. The site makes the Owner password on first setup
//                   and keeps it privately in the bucket (see DEPLOYMENT.md).
//   Upgrade         asks for nothing. Secrets, the Owner and the bucket are never touched.
//
// It checks what Cloudflare says about the Worker and bucket named in wrangler.jsonc first, and refuses (changing
// nothing) when the answer is unclear. See DEPLOYMENT.md.
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DeployRefusal, INITIAL_PASSWORD_OBJECT, install, OWNER_KEY, readinessVerdict, retrievalSteps } from './deploy-core.mjs';
import { parseJsonc } from './deploy-preflight-core.mjs';
import { secretFiles, wranglerRunner } from './deploy-wrangler.mjs';

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
		generateRoot: () => randomBytes(48).toString('base64'),
		log: (line) => console.log(line),
	});

	// Success means the installation answers and is ready, not only that wrangler exited 0
	if (!result.url) {
		throw new DeployRefusal(
			'no-address',
			`The deploy did not print the Worker address, so readiness could not be checked. Open your Worker in the Cloudflare dashboard and check /api/auth/methods there.`,
		);
	}
	const methods = await fetchMethods(result.url);
	const problems = readinessVerdict({
		methods,
		ownerExists: await wranglerRunner.objectExists(bucket.bucket_name, OWNER_KEY),
		credentialExists: await wranglerRunner.objectExists(bucket.bucket_name, INITIAL_PASSWORD_OBJECT),
		firstSetup: result.mode !== 'upgrade',
	});
	if (problems.length > 0) {
		console.error('Not ready yet:');
		for (const problem of problems) console.error(`  - ${problem}`);
		throw new DeployRefusal('not-ready', 'The installation is not ready. Run npm run deploy again once the problem above is fixed.');
	}

	if (result.mode === 'upgrade') {
		console.log('Ready. Your sign-in, Owner password and shares are unchanged.');
	} else {
		console.log('Ready. Finish setup with the steps below.');
		for (const line of retrievalSteps({ url: result.url, bucketName: bucket.bucket_name })) console.log(`  ${line}`);
	}
}

// The sign-in status of the installed Worker, or null. A slow or failing answer is "could not read", never "ready".
async function fetchMethods(url) {
	try {
		const response = await fetch(`${url}/api/auth/methods`, { signal: AbortSignal.timeout(30_000) });
		if (!response.ok) return null;
		return await response.json();
	} catch {
		return null;
	}
}

main().catch((error) => {
	console.error(error instanceof DeployRefusal ? `Refused (${error.code}): ${error.message}` : `Deploy failed: ${error.message}`);
	process.exitCode = 1;
});
