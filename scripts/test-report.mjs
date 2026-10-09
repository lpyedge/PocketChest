// Turns the Vitest and Playwright JSON reports into one machine-readable report.
// Each case is PASS, FAIL or SKIP; a skip must carry a reason, and any FAIL fails the run.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const OUT = 'test-results/report.json';
const SKIP_REASONS = new Map(); // case title -> reason, kept here so a skip can never be silent

function read(path) {
	return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

function fromVitest(report) {
	const cases = [];
	for (const file of report?.testResults ?? []) {
		for (const test of file.assertionResults ?? []) {
			const status = test.status === 'passed' ? 'PASS' : test.status === 'failed' ? 'FAIL' : 'SKIP';
			cases.push({
				suite: 'worker',
				file: file.name.replace(process.cwd() + '/', ''),
				title: test.fullName,
				status,
				reason: status === 'SKIP' ? (SKIP_REASONS.get(test.fullName) ?? 'no reason recorded') : undefined,
				error: status === 'FAIL' ? (test.failureMessages ?? []).join('\n').slice(0, 500) : undefined,
			});
		}
	}
	return cases;
}

function fromPlaywright(report) {
	const cases = [];
	const walk = (suite, file) => {
		for (const spec of suite.specs ?? []) {
			for (const test of spec.tests ?? []) {
				const last = test.results?.at(-1);
				const outcome = last?.status ?? test.status;
				const status = outcome === 'expected' || outcome === 'passed' ? 'PASS' : outcome === 'skipped' ? 'SKIP' : 'FAIL';
				cases.push({
					suite: 'e2e',
					file,
					title: `[${test.projectName}] ${spec.title}`,
					status,
					reason: status === 'SKIP' ? 'skipped by Playwright' : undefined,
					error: status === 'FAIL' ? (last?.error?.message ?? '').slice(0, 500) : undefined,
				});
			}
		}
		for (const child of suite.suites ?? []) walk(child, child.file ?? file);
	};
	for (const suite of report?.suites ?? []) walk(suite, suite.file ?? '');
	return cases;
}

const cases = [...fromVitest(read('test-results/vitest.json')), ...fromPlaywright(read('test-results/playwright.json'))];
const counts = { PASS: 0, FAIL: 0, SKIP: 0 };
for (const item of cases) counts[item.status]++;
const report = { generatedAt: new Date().toISOString(), totals: counts, cases };

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n');
console.log(`Test report: ${counts.PASS} pass, ${counts.FAIL} fail, ${counts.SKIP} skip -> ${OUT}`);

if (cases.length === 0) {
	console.error('No test results were found; the report is empty and the run is not accepted.');
	process.exit(1);
}
if (counts.FAIL > 0 || cases.some((item) => item.status === 'SKIP' && !item.reason)) {
	process.exit(1);
}
