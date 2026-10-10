#!/usr/bin/env node
// Prepares a reviewable branch that brings the official PocketChest code into a copy or fork. Used by
// .github/workflows/upstream-update.yml, and runnable by hand:  node scripts/prepare-upstream-update.mjs
//
// It never deploys, never pushes and never touches Cloudflare. It merges the pinned upstream ref into a NEW branch
// and checks that the merge kept this installation's identity (Worker name, bucket, routes, passkey domain). When it
// cannot do that cleanly it undoes everything and says why; it never overwrites your settings to make a merge succeed.
//
// Prints one JSON line: { status, branch?, upstreamSha?, protectedReverted?, problems?, files? }
//   ready | up-to-date | conflict | identity-changed | dirty
// Exit codes: 0 ready / up-to-date, 2 conflict, 3 identity-changed, 4 dirty or unusable repository.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluate } from './deploy-preflight-core.mjs';

// Files this tool never takes from upstream: a token without the `workflow` scope cannot push them, and your own
// automation is yours to keep. Anything upstream changed there is put back and listed in the result.
export const PROTECTED_PATHS = ['.github/workflows/'];
export const CONFIG_FILE = 'wrangler.jsonc';

function defaultGit(cwd) {
	return (args, options = {}) => {
		try {
			return { ok: true, out: execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() };
		} catch (error) {
			if (options.allowFailure) return { ok: false, out: `${error.stdout ?? ''}${error.stderr ?? ''}`.trim() };
			throw new Error(`git ${args.join(' ')} failed: ${String(error.stderr ?? error.message).split('\n')[0]}`);
		}
	};
}

export function prepareUpdate({
	cwd = process.cwd(),
	upstreamRef = 'upstream/master',
	branchPrefix = 'update/pocketchest-',
	git = defaultGit(cwd),
} = {}) {
	if (git(['status', '--porcelain']).out !== '') {
		return { status: 'dirty', problems: ['The working tree has uncommitted changes; commit or stash them first. Nothing was changed.'] };
	}
	const upstreamSha = git(['rev-parse', '--verify', `${upstreamRef}^{commit}`]).out;
	if (git(['merge-base', '--is-ancestor', upstreamSha, 'HEAD'], { allowFailure: true }).ok) {
		return { status: 'up-to-date', upstreamSha };
	}

	const startBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']).out;
	const startSha = git(['rev-parse', 'HEAD']).out;
	const ourConfig = git(['show', `HEAD:${CONFIG_FILE}`]).out;
	const branch = `${branchPrefix}${upstreamSha.slice(0, 12)}`;
	if (git(['rev-parse', '--verify', `refs/heads/${branch}`], { allowFailure: true }).ok) {
		return { status: 'up-to-date', upstreamSha, branch, problems: [`Branch ${branch} already exists; review or delete it first.`] };
	}

	// Leaves the repository exactly as it was found
	const restore = () => {
		git(['merge', '--abort'], { allowFailure: true });
		git(['reset', '--hard', startSha], { allowFailure: true });
		git(['switch', startBranch], { allowFailure: true });
		git(['branch', '-D', branch], { allowFailure: true });
	};

	git(['switch', '-c', branch]);
	const merged = git(['merge', '--no-commit', '--no-ff', upstreamRef], { allowFailure: true });
	if (!merged.ok) {
		const files = git(['diff', '--name-only', '--diff-filter=U'], { allowFailure: true }).out.split('\n').filter(Boolean);
		restore();
		return {
			status: 'conflict',
			upstreamSha,
			files,
			problems: ['Upstream and this copy changed the same lines. Resolve it by merging upstream by hand.'],
		};
	}

	// Put back anything upstream changed under a protected path
	const protectedReverted = [];
	for (const file of git(['diff', '--cached', '--name-only']).out.split('\n').filter(Boolean)) {
		if (!PROTECTED_PATHS.some((prefix) => file.startsWith(prefix))) continue;
		if (git(['cat-file', '-e', `HEAD:${file}`], { allowFailure: true }).ok) git(['checkout', 'HEAD', '--', file]);
		else git(['rm', '-f', '-q', '--', file], { allowFailure: true });
		protectedReverted.push(file);
	}

	// The merged configuration must still be this installation's: same Worker, bucket, routes, passkey domain
	let verdict;
	try {
		verdict = evaluate(ourConfig, readFileSync(`${cwd}/${CONFIG_FILE}`, 'utf8'));
	} catch (error) {
		restore();
		return { status: 'identity-changed', upstreamSha, problems: [`Could not read the merged ${CONFIG_FILE}: ${error.message}`] };
	}
	if (!verdict.ok) {
		restore();
		return { status: 'identity-changed', upstreamSha, problems: verdict.problems };
	}

	if (git(['diff', '--cached', '--quiet'], { allowFailure: true }).ok) {
		restore();
		return { status: 'up-to-date', upstreamSha, protectedReverted };
	}
	git(['commit', '-q', '-m', `Update from PocketChest upstream ${upstreamSha.slice(0, 12)}`]);
	return { status: 'ready', branch, upstreamSha, protectedReverted };
}

const EXIT = { ready: 0, 'up-to-date': 0, conflict: 2, 'identity-changed': 3, dirty: 4 };

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const ref = process.argv.includes('--upstream-ref') ? process.argv[process.argv.indexOf('--upstream-ref') + 1] : undefined;
	try {
		const result = prepareUpdate({ upstreamRef: ref });
		console.log(JSON.stringify(result));
		process.exitCode = EXIT[result.status] ?? 4;
	} catch (error) {
		console.log(JSON.stringify({ status: 'dirty', problems: [error.message] }));
		process.exitCode = 4;
	}
}
