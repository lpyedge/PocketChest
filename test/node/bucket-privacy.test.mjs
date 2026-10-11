// The privacy gate trusts only clear answers from wrangler. Anything it cannot read must throw, never read as private.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCustomDomains, parseDevUrl } from '../../scripts/deploy-wrangler.mjs';

test('r2.dev access: disabled is private, enabled is public, anything else is unclear', () => {
	assert.equal(parseDevUrl('r2.dev access is disabled for this bucket'), false);
	assert.equal(parseDevUrl('Public access: Enabled'), true);
	assert.throws(() => parseDevUrl('something unexpected'), /Unexpected answer/);
	assert.throws(() => parseDevUrl('enabled and disabled'), /Unexpected answer/);
});

test('custom domains: an explicit "none" is zero, listed hostnames are counted, unclear throws', () => {
	assert.equal(parseCustomDomains('No custom domains connected'), 0);
	assert.equal(parseCustomDomains('cdn.example.com (active)\nfiles.example.org (active)'), 2);
	assert.equal(parseCustomDomains('cdn.example.com\ncdn.example.com'), 1);
	assert.throws(() => parseCustomDomains('?'), /Unexpected answer/);
});
