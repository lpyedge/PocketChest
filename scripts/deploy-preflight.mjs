// Usage: node scripts/deploy-preflight.mjs --current <wrangler.jsonc of the installation> [--candidate wrangler.jsonc]
//          [--current-secrets A,B] [--candidate-secrets A,B] [--snapshot]
// Offline only. Exit 0: the upgrade keeps the installation's identity. Exit 1: it would not (reasons on stderr).
import { readFileSync } from 'node:fs';
import { compare, parseJsonc, snapshot } from './deploy-preflight-core.mjs';

const args = process.argv.slice(2);
const option = (name) => {
	const at = args.indexOf(name);
	return at === -1 ? undefined : args[at + 1];
};
const names = (value) =>
	value
		? value
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean)
		: [];
const load = (path, secrets) => snapshot(parseJsonc(readFileSync(path, 'utf8')), names(secrets));

try {
	const currentPath = option('--current');
	if (!currentPath) throw new Error('--current <wrangler.jsonc> is required');
	const current = load(currentPath, option('--current-secrets'));
	if (args.includes('--snapshot')) {
		console.log(JSON.stringify(current, null, 2));
		process.exit(0);
	}
	const candidate = load(option('--candidate') ?? 'wrangler.jsonc', option('--candidate-secrets'));
	const problems = compare(current, candidate);
	if (problems.length > 0) {
		console.error("Upgrade refused: it would change this installation's identity.");
		for (const problem of problems) console.error(`  - ${problem}`);
		process.exit(1);
	}
	console.log('Preflight passed: Worker, bucket, routes, passkey domain and setup state are unchanged.');
} catch (error) {
	console.error(`Preflight could not run: ${error.message}`);
	process.exit(1);
}
