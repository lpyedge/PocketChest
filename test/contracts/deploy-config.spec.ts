import { describe, it, expect } from 'vitest';
import devVarsExample from '../../.dev.vars.example?raw';
import wranglerConfig from '../../wrangler.jsonc?raw';
import packageJson from '../../package.json?raw';

// The Cloudflare Deploy Button turns every uncommented name in .dev.vars.example into a secret it asks for, and
// reads package.json "cloudflare.bindings" for their descriptions. A name that wrangler.jsonc already sets as a plain
// variable would be asked for as a secret as well, and then fight with the configured value.
const SECRETS = ['ADMIN_BOOTSTRAP_PASSWORD', 'JWT_SECRET'];

const namesIn = (text: string) =>
	text
		.split('\n')
		.filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
		.map((line) => line.split('=')[0].trim())
		.sort();

// jsonc: drop comments (keeping text inside strings) and trailing commas, then read it as JSON
function wrangler(): { vars: Record<string, string> } {
	const json = wranglerConfig
		.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_, text) => text ?? '')
		.replace(/,(\s*[}\]])/g, '$1');
	return JSON.parse(json);
}

describe('deploy button configuration', () => {
	it('asks for exactly the required secrets (and none for the authenticator: its key is derived)', () => {
		expect(namesIn(devVarsExample)).toEqual(SECRETS);
	});

	it('gives each of them a description in package.json, and no others', () => {
		const bindings = Object.keys(JSON.parse(packageJson).cloudflare.bindings).sort();
		expect(bindings).toEqual(SECRETS);
	});

	it('keeps plain variables out of the secrets form', () => {
		const variables = Object.keys(wrangler().vars);
		expect(variables).toContain('BOOTSTRAP_ENABLED');
		for (const name of namesIn(devVarsExample)) expect(variables, `${name} is both a secret and a variable`).not.toContain(name);
	});

	it('only offers placeholders as defaults, never a usable value', () => {
		for (const line of devVarsExample.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('#'))) {
			expect(line.split('=')[1], line).toMatch(/^REPLACE_WITH_/);
		}
	});
});

describe('upgrade preflight', () => {
	it('accepts the shipped wrangler.jsonc against itself', async () => {
		const { evaluate } = await import('../../scripts/deploy-preflight-core.mjs');
		expect(evaluate(wranglerConfig, wranglerConfig)).toEqual({ ok: true, problems: [] });
	});
});
