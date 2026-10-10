import { describe, it, expect } from 'vitest';
import { compare, evaluate, parseJsonc, snapshot } from '../scripts/deploy-preflight-core.mjs';

const base = `{
	// comment
	"name": "my-chest",
	"r2_buckets": [{ "bucket_name": "my-bucket", "binding": "R2_STORAGE" },],
	"routes": [{ "pattern": "share.example.com", "custom_domain": true }],
	"vars": { "BOOTSTRAP_ENABLED": "false", "PASSKEY_RP_ID": "share.example.com" },
}`;
const withChange = (change: (c: any) => void) => {
	const c = parseJsonc(base);
	change(c);
	return snapshot(c);
};
const current = snapshot(parseJsonc(base), ['JWT_SECRET', 'ADMIN_BOOTSTRAP_PASSWORD']);

describe('deploy preflight comparison', () => {
	it('passes when nothing identifying changed (code and assets only)', () => {
		const c = parseJsonc(base);
		c.compatibility_date = '2030-01-01';
		c.assets = { directory: './dist' };
		expect(compare(current, snapshot(c, ['JWT_SECRET', 'ADMIN_BOOTSTRAP_PASSWORD']))).toEqual([]);
	});

	it.each([
		['worker name', (c: any) => (c.name = 'pocket-chest')],
		['bucket name', (c: any) => (c.r2_buckets[0].bucket_name = 'pocket-chest')],
		['bucket binding removed', (c: any) => (c.r2_buckets = [])],
		['routes', (c: any) => (c.routes = [])],
		['passkey rp id', (c: any) => (c.vars.PASSKEY_RP_ID = 'other.example.com')],
		['bootstrap back on', (c: any) => (c.vars.BOOTSTRAP_ENABLED = 'true')],
	])('fails when the %s changes', (_label, change) => {
		const problems = compare(current, withChange(change));
		expect(problems.length).toBeGreaterThan(0);
	});

	it('fails when an expected secret name disappears', () => {
		const problems = compare(current, snapshot(parseJsonc(base), ['ADMIN_BOOTSTRAP_PASSWORD']));
		expect(problems.join()).toContain('JWT_SECRET');
	});

	it('allows bootstrap to stay on while the installation is still being set up', () => {
		const first = withChange((c) => (c.vars.BOOTSTRAP_ENABLED = 'true'));
		expect(compare(first, first)).toEqual([]);
	});

	it('never puts secret values in the snapshot, only names', () => {
		expect(JSON.stringify(current)).not.toMatch(/REPLACE_WITH/);
	});
});

describe('deploy preflight evaluation', () => {
	it('reports ok for an unchanged installation and reasons otherwise', () => {
		expect(evaluate(base, base)).toEqual({ ok: true, problems: [] });
		const bad = evaluate(base, base.replace('my-bucket', 'new-bucket'));
		expect(bad.ok).toBe(false);
		expect(bad.problems.join()).toContain('R2_STORAGE');
	});

	it('fails closed on an unreadable configuration', () => {
		expect(() => evaluate('not json', base)).toThrow();
	});
});
