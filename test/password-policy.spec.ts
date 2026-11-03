import { describe, it, expect } from 'vitest';
import { passwordProblem, MIN_PASSWORD_LENGTH } from '../src/worker/auth/password-policy';

// Owner-chosen passwords (change and reset in the Worker) follow this rule. The initial owner password is generated
// by the Worker and is not checked against it.
const FIXTURES: Array<[string, string | null]> = [
	['', 'TOO_SHORT'],
	['1234567', 'TOO_SHORT'],
	['short-1', 'TOO_SHORT'],
	['😀'.repeat(7), 'TOO_SHORT'],
	['😀'.repeat(8), 'NEEDS_LETTER_AND_DIGIT'],
	['aaaaaaaa', 'NEEDS_LETTER_AND_DIGIT'],
	['Password', 'NEEDS_LETTER_AND_DIGIT'],
	['12345678', 'NEEDS_LETTER_AND_DIGIT'],
	['correct horse battery', 'NEEDS_LETTER_AND_DIGIT'],
	['REPLACE_WITH_A_PASSWORD', 'NEEDS_LETTER_AND_DIGIT'],
	['aaaaaaa1', 'WEAK'],
	['abababa1', 'WEAK'],
	['Password1', 'WEAK'],
	['replace-with-1', 'WEAK'],
	['change-me-1', 'WEAK'],
	['Kx7pq2mz', null],
	['pässwörd9', null],
	['密碼密碼密碼密碼a1', null],
	['a-new-passphrase-that-is-long-enough-2', null],
];

describe('owner password policy', () => {
	it('uses eight characters as the minimum', () => {
		expect(MIN_PASSWORD_LENGTH).toBe(8);
	});

	it.each(FIXTURES)('classifies %j', (password, expected) => {
		expect(passwordProblem(password)).toBe(expected);
	});
});
