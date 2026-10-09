#!/usr/bin/env node
// Creates .dev.vars for local development with fresh random secrets (never the example placeholders).
//   npm run setup:local            create .dev.vars; refuses to overwrite an existing one
//   npm run setup:local -- --force replace it
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const target = '.dev.vars';
if (existsSync(target) && !process.argv.includes('--force')) {
	console.error(`${target} already exists; leaving it alone. Use --force to replace it.`);
	process.exit(1);
}

const secrets = {
	JWT_SECRET: randomBytes(48).toString('base64'),
	AUTH_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
	ADMIN_BOOTSTRAP_PASSWORD: randomBytes(24).toString('base64'),
};

// Keep the comments and the other settings of the example; only the REPLACE_WITH_ values change
const lines = readFileSync('.dev.vars.example', 'utf8')
	.split('\n')
	.map((line) => {
		const [name] = line.split('=');
		return name in secrets ? `${name}=${secrets[name]}` : line;
	});
writeFileSync(target, lines.join('\n'), { mode: 0o600 });
console.log(`Wrote ${target} with new random secrets.`);
console.log('Sign in at /upload/ with ADMIN_BOOTSTRAP_PASSWORD on first use; it is also the owner password until you change it.');
