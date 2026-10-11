// The runner and file helpers that talk to Cloudflare through wrangler, with the deployer's own credentials
// (wrangler login, or CLOUDFLARE_API_TOKEN in CI / Workers Builds). Not exercised against a real account by the tests:
// every parse here fails closed, so an unexpected answer is a refusal, never "absent".
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wranglerGet } from './recovery-io.mjs';

const WORKER_MISSING = /10007|could not find|does not exist|not found/i;
const BUCKET_MISSING = /10006|does not exist|not found|no such bucket/i;

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
	async deploy({ secretsFile, keepVars }) {
		const args = ['deploy'];
		if (secretsFile) args.push('--secrets-file', secretsFile);
		if (keepVars) args.push('--keep-vars');
		execFileSync('npx', ['wrangler', ...args], { stdio: 'inherit' });
	},
};

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
