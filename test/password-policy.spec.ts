import { describe, it, expect } from 'vitest';
import { passwordProblem as workerProblem, MIN_PASSWORD_LENGTH as WORKER_MIN } from '../src/worker/auth/password-policy';
import * as core from '../scripts/recovery-core.mjs';

// The Worker (TypeScript) and the offline CLI (recovery-core.mjs) each carry the same policy. Both must
// answer identically, or an Owner could set a password through one path that the other path rejects.
const FIXTURES: Array<[string, string | null]> = [
	['', 'TOO_SHORT'],
	['1234567', 'TOO_SHORT'],
	['short-1', 'TOO_SHORT'],
	['😀'.repeat(7), 'TOO_SHORT'],
	['😀'.repeat(8), 'WEAK'],
	['aaaaaaaa', 'WEAK'],
	['abababab', 'WEAK'],
	['Password', 'WEAK'],
	['12345678', 'WEAK'],
	['REPLACE_WITH_A_PASSWORD', 'WEAK'],
	['change-me-please', 'WEAK'],
	['Kx7pq2mz', null],
	['correct horse battery', null],
	['a-new-passphrase-that-is-long-enough', null],
];

describe('shared password policy', () => {
	it('uses eight characters as the minimum in both the Worker and the CLI', () => {
		expect(WORKER_MIN).toBe(8);
		expect(core.MIN_PASSWORD_LENGTH).toBe(8);
	});

	it.each(FIXTURES)('answers the same way for %j', (password, expected) => {
		expect(workerProblem(password)).toBe(expected);
		expect(core.passwordProblem(password)).toBe(expected);
	});

	it('keeps the initial-setup minimum at sixteen until the setup task replaces it', () => {
		expect(core.MIN_BOOTSTRAP_PASSWORD_LENGTH).toBe(16);
	});
});
