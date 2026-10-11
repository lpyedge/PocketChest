// The runner and file helpers that talk to Cloudflare through wrangler, with the deployer's own credentials
// (wrangler login, or CLOUDFLARE_API_TOKEN in CI / Workers Builds). Not exercised against a real account by the tests:
// every parse here fails closed, so an unexpected answer is a refusal, never "absent".
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wranglerGet } from './recovery-io.mjs';

const WORKER_MISSING = /10007|could not find|does not exist|not found/i;
// Only an explicit "bucket does not exist" answer counts as absent. Any other error (permissions, service not enabled) is unclear
const BUCKET_MISSING = /10006|bucket[^\n]*does not exist|no such bucket/i;

const run = (args) =>
	execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } });
const failure = (error) => String(error?.stderr ?? error?.message ?? error);

export const wranglerRunner = {
	async secretNames(worker) {
		let output;
		try {
			output = run(['secret', 'list', '--name', worker, '--format', 'json']);
		} catch (error) {
			if (WORKER_MISSING.test(failure(error))) return null;
			throw new Error(failure(error).split('\n')[0]);
		}
		const start = output.indexOf('[');
		const parsed = start === -1 ? null : JSON.parse(output.slice(start));
		if (!Array.isArray(parsed) || !parsed.every((item) => typeof item?.name === 'string')) {
			throw new Error('Unexpected answer from "wrangler secret list"');
		}
		return parsed.map((item) => item.name);
	},
	async bucketExists(bucket) {
		try {
			run(['r2', 'bucket', 'info', bucket]);
			return true;
		} catch (error) {
			if (BUCKET_MISSING.test(failure(error))) return false;
			throw new Error(failure(error).split('\n')[0]);
		}
	},
	async objectExists(bucket, key) {
		return wranglerGet(bucket, key) !== null;
	},
	async createBucket(bucket) {
		run(['r2', 'bucket', 'create', bucket]);
	},
	async bucketPrivacy(bucket) {
		const publicDevUrl = parseDevUrl(run(['r2', 'bucket', 'dev-url', 'get', bucket]));
		const customDomains = parseCustomDomains(run(['r2', 'bucket', 'domain', 'list', bucket]));
		return { publicDevUrl, customDomains };
	},
	async deploy({ secretsFile, keepVars }) {
		const args = ['deploy'];
		if (secretsFile) args.push('--secrets-file', secretsFile);
		if (keepVars) args.push('--keep-vars');
		const output = execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
		process.stdout.write(output);
		return { url: parseWorkerUrl(output) };
	},
};

// Public access to a bucket: "disabled" (private) or "enabled". Anything else is unclear, so it throws.
export function parseDevUrl(output) {
	const disabled = /\bdisabled\b/i.test(output);
	const enabled = /\benabled\b/i.test(output);
	if (disabled && !enabled) return false;
	if (enabled && !disabled) return true;
	throw new Error('Unexpected answer from "wrangler r2 bucket dev-url get"');
}

// Custom domains on a bucket: 0 when the answer says there are none, the number of hostnames otherwise. Unclear throws.
export function parseCustomDomains(output) {
	if (/no (custom )?domains?/i.test(output)) return 0;
	const hosts = output.match(/\b[a-z0-9-]+(\.[a-z0-9-]+)+\b/gi) ?? [];
	if (hosts.length > 0) return new Set(hosts.map((host) => host.toLowerCase())).size;
	throw new Error('Unexpected answer from "wrangler r2 bucket domain list"');
}

// The address wrangler printed for the Worker (workers.dev), or null when it printed none
export function parseWorkerUrl(output) {
	const match = output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev\b/i);
	return match ? match[0].replace(/\.$/, '') : null;
}

// A private temporary file for the one-time secrets, always removed afterwards
export const secretFiles = {
	async write(object) {
		const dir = mkdtempSync(join(tmpdir(), 'pocketchest-secrets-'));
		const path = join(dir, 'secrets.json');
		writeFileSync(path, JSON.stringify(object), { mode: 0o600 });
		chmodSync(path, 0o600);
		return path;
	},
	async remove(path) {
		rmSync(join(path, '..'), { recursive: true, force: true });
	},
};
