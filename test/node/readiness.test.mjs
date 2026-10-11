// What the installer reports as ready, and the text a person is given. Ready needs proof, and no secret bytes may appear.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_PASSWORD_OBJECT, readinessVerdict, retrievalSteps } from '../../scripts/deploy-core.mjs';
import { parseWorkerUrl } from '../../scripts/deploy-wrangler.mjs';

const READY = { setup: 'ready', methods: { password: { enabled: true }, totp: { enabled: false }, passkey: { enabled: false } } };

test('a first setup is ready only with ready sign-in, the owner and the first password object', () => {
	assert.deepEqual(readinessVerdict({ methods: READY, ownerExists: true, credentialExists: true, firstSetup: true }), []);
	const missing = readinessVerdict({
		methods: { setup: 'password-missing', methods: { password: { enabled: false } } },
		ownerExists: false,
		credentialExists: false,
		firstSetup: true,
	});
	assert.equal(missing.length, 4);
	assert.match(missing.join('\n'), /setup state is "password-missing"/);
	assert.ok(missing.join('\n').includes(INITIAL_PASSWORD_OBJECT));
});

test('an unreadable status is "could not read", never ready', () => {
	const problems = readinessVerdict({ methods: null, ownerExists: true, credentialExists: true, firstSetup: true });
	assert.deepEqual(problems, ['the sign-in status could not be read from the Worker URL']);
});

test('an upgrade does not need the first password object, which is removed after the owner changed it', () => {
	assert.deepEqual(readinessVerdict({ methods: READY, ownerExists: true, credentialExists: false, firstSetup: false }), []);
});

test('the retrieval steps name the URL, bucket and object key, and never contain a password', () => {
	const text = retrievalSteps({ url: 'https://pocket.example.workers.dev', bucketName: 'pocket-chest' }).join('\n');
	assert.match(text, /https:\/\/pocket\.example\.workers\.dev\/upload\//);
	assert.match(text, /pocket-chest/);
	assert.ok(text.includes(INITIAL_PASSWORD_OBJECT));
	assert.match(text, /Download/);
	assert.doesNotMatch(text, /[A-Za-z0-9_-]{43}/);
});

test('the Worker address is taken from wrangler output, and absent when none is printed', () => {
	assert.equal(
		parseWorkerUrl('Deployed pocket\n  https://pocket-chest.acme-team.workers.dev\n'),
		'https://pocket-chest.acme-team.workers.dev',
	);
	assert.equal(parseWorkerUrl('Deployed, no address printed'), null);
});
