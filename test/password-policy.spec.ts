import { describe, it, expect } from 'vitest';
import { passwordProblem, MIN_PASSWORD_LENGTH } from '../src/worker/auth/password-policy';

// Owner-chosen passwords (change and reset in the Worker) follow this rule. The initial owner password is generated
// by the Worker and is not checked against it.
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

describe('owner password policy', () => {
	it('uses eight characters as the minimum', () => {
		expect(MIN_PASSWORD_LENGTH).toBe(8);
	});

	it.each(FIXTURES)('classifies %j', (password, expected) => {
		expect(passwordProblem(password)).toBe(expected);
	});
});
