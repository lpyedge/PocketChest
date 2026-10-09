// Fails when a retired protocol reference is used outside the tests that assert it is gone.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
// Shipped code and configuration only. Tests may mention retired forms, because they assert those are refused.
const SCAN = ['src', 'scripts', 'public', 'wrangler.jsonc', 'vitest.config.mts', 'playwright.config.ts', '.github'];
const ALLOWED = new Set(['scripts/check-legacy.mjs']);
const PATTERNS = [
	{ name: 'REQUIRE_TOTP', re: /REQUIRE_TOTP/ },
	{ name: 'TOTP_SECRETS', re: /TOTP_SECRETS/ },
	{ name: 'D1 migration', re: /migrate-d1|d1_databases|D1Database/ },
	{ name: 'legacy chest route', re: /\/api\/chest\b/ },
	{ name: 'legacy config route', re: /\/api\/config\b/ },
	{ name: 'query-string code or token', re: /\?code=|\?token=/ },
	{ name: 'legacy /share redirect', re: /['"`]\/share\/?['"`]/ },
	{ name: 'Next.js or KV runtime', re: /from ['"]next\/|kv_namespaces|KVNamespace/ },
];

function* files(path) {
	const full = join(ROOT, path);
	if (!statSync(full).isDirectory()) {
		yield path;
		return;
	}
	for (const entry of readdirSync(full)) {
		if (entry === 'node_modules' || entry === 'dist') continue;
		yield* files(join(path, entry));
	}
}

const findings = [];
for (const start of SCAN) {
	for (const file of files(start)) {
		const rel = relative(ROOT, join(ROOT, file)).replaceAll('\\', '/');
		if (ALLOWED.has(rel) || !/\.(ts|tsx|mts|mjs|js|json|jsonc|yml|yaml|html)$/.test(rel)) continue;
		const text = readFileSync(join(ROOT, file), 'utf8');
		text.split('\n').forEach((line, index) => {
			for (const pattern of PATTERNS) {
				if (pattern.re.test(line)) findings.push(`${rel}:${index + 1}  ${pattern.name}`);
			}
		});
	}
}

if (findings.length > 0) {
	console.error('Retired protocol references found:\n' + findings.join('\n'));
	process.exit(1);
}
console.log('No retired protocol references.');
