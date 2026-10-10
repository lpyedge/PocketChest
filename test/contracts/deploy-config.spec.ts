import { describe, it, expect } from 'vitest';
import devVarsExample from '../../.dev.vars.example?raw';
import wranglerConfig from '../../wrangler.jsonc?raw';
import packageJson from '../../package.json?raw';

// The Cloudflare Deploy Button turns every uncommented name in .dev.vars.example into a secret it asks for, and
// reads package.json "cloudflare.bindings" for their descriptions. A person installing PocketChest chooses exactly one
// thing: the Owner password. Everything else (the root secret, the authenticator key, the password key) is made or
// derived by the code, so none of it may appear in the form, nor as a plain variable in wrangler.jsonc.
const FORM_SECRETS = ['ADMIN_BOOTSTRAP_PASSWORD'];
const NEVER_ASKED = ['JWT_SECRET', 'AUTH_ENCRYPTION_KEY', 'BOOTSTRAP_ENABLED'];

const namesIn = (text: string) =>
	text
		.split('\n')
		.filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
		.map((line) => line.split('=')[0].trim())
		.sort();

// jsonc: drop comments (keeping text inside strings) and trailing commas, then read it as JSON
function wrangler(): { vars?: Record<string, string>; name: string } {
	const json = wranglerConfig
		.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_, text) => text ?? '')
		.replace(/,(\s*[}\]])/g, '$1');
	return JSON.parse(json);
}

describe('deploy button configuration', () => {
	it('asks for exactly one secret: the Owner password', () => {
		expect(namesIn(devVarsExample)).toEqual(FORM_SECRETS);
	});

	it('gives it a description in package.json, and no others', () => {
		const bindings = Object.keys(JSON.parse(packageJson).cloudflare.bindings).sort();
		expect(bindings).toEqual(FORM_SECRETS);
	});

	it('never asks for the root secret, an authenticator key or a setup switch', () => {
		const asked = [...namesIn(devVarsExample), ...Object.keys(JSON.parse(packageJson).cloudflare.bindings)];
		for (const name of NEVER_ASKED) expect(asked, name).not.toContain(name);
		expect(Object.keys(wrangler().vars ?? {})).toEqual([]);
	});

	it('keeps plain variables out of the secrets form', () => {
		const variables = Object.keys(wrangler().vars ?? {});
		for (const name of namesIn(devVarsExample)) expect(variables, `${name} is both a secret and a variable`).not.toContain(name);
	});

	it('only offers placeholders as defaults, never a usable value', () => {
		for (const line of devVarsExample.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('#'))) {
			expect(line.split('=')[1], line).toMatch(/^REPLACE_WITH_/);
		}
	});

	it('deploys through the installer, which generates the root secret, not through a bare wrangler deploy', () => {
		const scripts = JSON.parse(packageJson).scripts;
		expect(scripts.deploy).toContain('scripts/deploy.mjs');
		expect(scripts.deploy).not.toMatch(/wrangler deploy/);
	});

	it('no script or doc asks a person to generate a key by hand', () => {
		expect(JSON.stringify(JSON.parse(packageJson).scripts)).not.toMatch(/openssl/);
	});
});

describe('upgrade preflight', () => {
	it('accepts the shipped wrangler.jsonc against itself', async () => {
		const { evaluate } = await import('../../scripts/deploy-preflight-core.mjs');
		expect(evaluate(wranglerConfig, wranglerConfig)).toEqual({ ok: true, problems: [] });
	});
});

describe('upstream update workflow', () => {
	it('only prepares a pull request: no Cloudflare access, no deploy, no privileged trigger, no auto merge', async () => {
		const raw = (await import('../../.github/workflows/upstream-update.yml?raw')).default as string;
		// Comments may say what the workflow does not do; only the steps themselves are checked
		const workflow = raw.replace(/^\s*#.*$/gm, '');
		expect(workflow).not.toMatch(/pull_request_target/);
		expect(workflow).not.toMatch(/CLOUDFLARE_|CF_API|CF_TOKEN|wrangler|\$\{\{\s*secrets\./i);
		expect(workflow).not.toMatch(/gh pr merge|--auto|auto-merge|git push[^\n]*(--force|-f\b)/);
		expect(workflow).not.toMatch(/npm run deploy|npx wrangler deploy/);
		expect(workflow).toMatch(/workflow_dispatch/);
	});

	it('uses the least token permissions and a pinned official source', async () => {
		const workflow = (await import('../../.github/workflows/upstream-update.yml?raw')).default as string;
		expect(workflow).toMatch(/permissions:\n {2}contents: write\n {2}pull-requests: write\n/);
		expect(workflow).toContain('https://github.com/lpyedge/PocketChest.git');
		expect(workflow).toContain('fetch --no-tags upstream master');
		expect(workflow).toContain("github.repository != 'lpyedge/PocketChest'");
	});

	it('is documented', async () => {
		const operations = (await import('../../docs/OPERATIONS.md?raw')).default as string;
		expect(operations).toContain('Update from upstream');
	});
});
