// Runs with `node --test` (real git, temporary repositories): the update branch is built from fixtures of an
// upstream and of copies of it, and the copy's own settings must survive every outcome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { prepareUpdate } from '../../scripts/prepare-upstream-update.mjs';

// The merge inside prepareUpdate needs a committer identity; CI runners have none, so the fixtures bring their own
const IDENTITY = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
Object.assign(process.env, IDENTITY);
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const config = (name = 'pocket-chest', bucket = 'pocket-chest', extra = '') =>
	`{\n\t"name": "${name}",\n\t"r2_buckets": [{ "bucket_name": "${bucket}", "binding": "R2_STORAGE" }],\n\t"compatibility_date": "2025-08-13"${extra}\n}\n`;

function write(dir, file, text) {
	mkdirSync(join(dir, file, '..'), { recursive: true });
	writeFileSync(join(dir, file), text);
}
function commit(dir, message) {
	git(dir, 'add', '-A');
	git(dir, 'commit', '-q', '-m', message);
}

// upstream repo + a copy (clone) of it, as a person's own instance
function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'upstream-fixture-'));
	const upstream = join(root, 'upstream');
	mkdirSync(upstream);
	git(upstream, 'init', '-q', '-b', 'master');
	write(upstream, 'wrangler.jsonc', config());
	write(upstream, 'src/app.txt', 'line one\nline two\nline three\n');
	write(upstream, 'README.md', 'hello\n');
	write(upstream, '.github/workflows/ci.yml', 'name: CI\n');
	commit(upstream, 'initial');
	const copy = join(root, 'copy');
	git(root, 'clone', '-q', upstream, copy);
	git(copy, 'remote', 'rename', 'origin', 'upstream');
	git(copy, 'switch', '-q', '-c', 'main');
	return { root, upstream, copy, done: () => rmSync(root, { recursive: true, force: true }) };
}
const own = (dir) => ({
	branch: git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'),
	sha: git(dir, 'rev-parse', 'HEAD'),
	status: git(dir, 'status', '--porcelain'),
});

test('brings upstream code in on a new branch and keeps the copy settings', () => {
	const f = fixture();
	try {
		// The copy made its own settings; upstream changes code
		write(f.copy, 'wrangler.jsonc', config('my-chest', 'my-bucket', ',\n\t"vars": { "PASSKEY_RP_ID": "share.example.com" }'));
		commit(f.copy, 'my settings');
		write(f.upstream, 'src/app.txt', 'line one\nline two changed upstream\nline three\n');
		commit(f.upstream, 'upstream code');
		git(f.copy, 'fetch', '-q', 'upstream', 'master');

		const result = prepareUpdate({ cwd: f.copy });
		assert.equal(result.status, 'ready');
		assert.match(result.branch, /^update\/pocketchest-[0-9a-f]{12}$/);
		assert.equal(git(f.copy, 'rev-parse', '--abbrev-ref', 'HEAD'), result.branch);
		assert.match(readFileSync(join(f.copy, 'src/app.txt'), 'utf8'), /changed upstream/);
		const merged = readFileSync(join(f.copy, 'wrangler.jsonc'), 'utf8');
		assert.match(merged, /my-chest/);
		assert.match(merged, /my-bucket/);
		assert.match(merged, /share\.example\.com/);
	} finally {
		f.done();
	}
});

test('does nothing when the copy already has the upstream code', () => {
	const f = fixture();
	try {
		const before = own(f.copy);
		assert.equal(prepareUpdate({ cwd: f.copy }).status, 'up-to-date');
		assert.deepEqual(own(f.copy), before);
	} finally {
		f.done();
	}
});

test('a conflict undoes everything and names the files; nothing is overwritten', () => {
	const f = fixture();
	try {
		write(f.copy, 'README.md', 'hello from my copy\n');
		commit(f.copy, 'my readme');
		write(f.upstream, 'README.md', 'hello from upstream\n');
		commit(f.upstream, 'upstream readme');
		git(f.copy, 'fetch', '-q', 'upstream', 'master');
		const before = own(f.copy);

		const result = prepareUpdate({ cwd: f.copy });
		assert.equal(result.status, 'conflict');
		assert.deepEqual(result.files, ['README.md']);
		assert.deepEqual(own(f.copy), before);
		assert.equal(readFileSync(join(f.copy, 'README.md'), 'utf8'), 'hello from my copy\n');
		assert.equal(git(f.copy, 'branch', '--list', 'update/*'), '');
	} finally {
		f.done();
	}
});

test('refuses, and restores, when the merge would change the Worker, bucket or routes', () => {
	const f = fixture();
	try {
		// Upstream renames the bucket; the copy never touched that line, so git would merge it silently
		write(f.upstream, 'wrangler.jsonc', config('pocket-chest', 'another-bucket'));
		commit(f.upstream, 'rename bucket');
		git(f.copy, 'fetch', '-q', 'upstream', 'master');
		const before = own(f.copy);

		const result = prepareUpdate({ cwd: f.copy });
		assert.equal(result.status, 'identity-changed');
		assert.match(result.problems.join(' '), /R2_STORAGE/);
		assert.deepEqual(own(f.copy), before);
		assert.match(readFileSync(join(f.copy, 'wrangler.jsonc'), 'utf8'), /"pocket-chest"/);
	} finally {
		f.done();
	}
});

test('never takes workflow files from upstream, and lists what it put back', () => {
	const f = fixture();
	try {
		write(f.upstream, '.github/workflows/ci.yml', 'name: CI changed\n');
		write(f.upstream, '.github/workflows/new.yml', 'name: New\n');
		write(f.upstream, 'src/app.txt', 'line one\nline two\nline three\nfour\n');
		commit(f.upstream, 'workflows and code');
		git(f.copy, 'fetch', '-q', 'upstream', 'master');

		const result = prepareUpdate({ cwd: f.copy });
		assert.equal(result.status, 'ready');
		assert.deepEqual([...result.protectedReverted].sort(), ['.github/workflows/ci.yml', '.github/workflows/new.yml']);
		assert.equal(readFileSync(join(f.copy, '.github/workflows/ci.yml'), 'utf8'), 'name: CI\n');
		assert.throws(() => readFileSync(join(f.copy, '.github/workflows/new.yml')));
		assert.match(readFileSync(join(f.copy, 'src/app.txt'), 'utf8'), /four/);
	} finally {
		f.done();
	}
});

test('an update that only touches workflow files leaves nothing to review', () => {
	const f = fixture();
	try {
		write(f.upstream, '.github/workflows/ci.yml', 'name: CI changed\n');
		commit(f.upstream, 'workflow only');
		git(f.copy, 'fetch', '-q', 'upstream', 'master');
		const before = own(f.copy);
		const result = prepareUpdate({ cwd: f.copy });
		assert.equal(result.status, 'up-to-date');
		assert.deepEqual(own(f.copy), before);
	} finally {
		f.done();
	}
});

test('refuses to start on a dirty working tree', () => {
	const f = fixture();
	try {
		write(f.copy, 'scratch.txt', 'unsaved\n');
		assert.equal(prepareUpdate({ cwd: f.copy }).status, 'dirty');
		assert.equal(readFileSync(join(f.copy, 'scratch.txt'), 'utf8'), 'unsaved\n');
	} finally {
		f.done();
	}
});

test('a merge git refuses for another reason is reported as that reason, not as a conflict', () => {
	const f = fixture();
	const saved = { ...process.env };
	try {
		write(f.upstream, 'src/app.txt', 'line one\nline two changed upstream\nline three\n');
		commit(f.upstream, 'upstream code');
		git(f.copy, 'fetch', '-q', 'upstream', 'master');
		const before = own(f.copy);
		// No committer identity anywhere: git refuses the merge before touching a file
		for (const key of Object.keys(IDENTITY)) delete process.env[key];
		process.env.HOME = f.root;
		process.env.XDG_CONFIG_HOME = f.root;
		process.env.GIT_CONFIG_NOSYSTEM = '1';
		process.env.GIT_COMMITTER_NAME = '';
		assert.throws(() => prepareUpdate({ cwd: f.copy }), /git merge upstream\/master failed/);
		Object.assign(process.env, saved);
		assert.deepEqual(own(f.copy), before);
		assert.equal(git(f.copy, 'branch', '--list', 'update/*'), '');
	} finally {
		for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
		f.done();
	}
});
