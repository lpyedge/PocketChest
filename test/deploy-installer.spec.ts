import { describe, it, expect } from 'vitest';
import { decide, DeployRefusal, install, inspectTarget, passwordProblem, JWT_SECRET, SETUP_PASSWORD } from '../scripts/deploy-core.mjs';

const GOOD = 'a-long-enough-owner-password-2026';

interface World {
	secrets: string[] | null; // null: the Worker does not exist yet
	bucket: boolean;
	owner: boolean;
	marker: boolean;
}

// A pretend Cloudflare: answers from `world`, records every change, and can be told to fail
function harness(world: World, options: { failOn?: string; deployFails?: boolean; changeBeforeDeploy?: Partial<World> } = {}) {
	const calls: string[] = [];
	const deploys: { secretsFile: string | null; keepVars: boolean; written: Record<string, string> | null }[] = [];
	const store = new Map<string, Record<string, string>>();
	let reads = 0;
	const runner = {
		async secretNames() {
			calls.push('secretNames');
			if (options.failOn === 'secretNames') throw new Error('API error 5xx');
			if (++reads > 1 && options.changeBeforeDeploy) Object.assign(world, options.changeBeforeDeploy);
			return world.secrets;
		},
		async bucketExists() {
			calls.push('bucketExists');
			if (options.failOn === 'bucketExists') throw new Error('permission denied');
			return world.bucket;
		},
		async objectExists(_bucket: string, key: string) {
			calls.push(`objectExists:${key}`);
			if (options.failOn === 'objectExists') throw new Error('timeout');
			return key.endsWith('owner.json') ? world.owner : world.marker;
		},
		async deploy({ secretsFile, keepVars }: { secretsFile: string | null; keepVars: boolean }) {
			calls.push('deploy');
			deploys.push({ secretsFile, keepVars, written: secretsFile ? (store.get(secretsFile) ?? null) : null });
			if (options.deployFails) throw new Error('deploy failed');
		},
	};
	const removed: string[] = [];
	const files = {
		async write(object: Record<string, string>) {
			calls.push('write');
			const path = `/tmp/secrets-${store.size}.json`;
			store.set(path, object);
			return path;
		},
		async remove(path: string) {
			removed.push(path);
		},
	};
	const logs: string[] = [];
	return { runner, files, calls, deploys, removed, logs, log: (line: string) => logs.push(line) };
}

const fresh = (): World => ({ secrets: null, bucket: true, owner: false, marker: false });
const installed = (): World => ({ secrets: [JWT_SECRET, SETUP_PASSWORD], bucket: true, owner: true, marker: true });

function run(h: ReturnType<typeof harness>, env: Record<string, string> = {}, promptPassword?: () => Promise<string | null>) {
	let roots = 0;
	return install({
		runner: h.runner,
		files: h.files,
		workerName: 'pocket-chest',
		bucketName: 'pocket-chest',
		env,
		promptPassword,
		generateRoot: () => `generated-root-${++roots}-${'x'.repeat(40)}`,
		log: h.log,
	});
}

const refusal = async (promise: Promise<unknown>) => {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(DeployRefusal);
		return error as DeployRefusal;
	}
	throw new Error('expected a refusal');
};

describe('first install', () => {
	it('with an Owner password: uploads one generated root and the password with the code, exactly once', async () => {
		const h = harness(fresh());
		const result = await run(h, { [SETUP_PASSWORD]: GOOD });
		expect(result.mode).toBe('fresh');
		expect(result.uploaded.sort()).toEqual([JWT_SECRET, SETUP_PASSWORD].sort());
		expect(h.deploys).toHaveLength(1);
		expect(h.deploys[0].written).toEqual({ [JWT_SECRET]: expect.stringMatching(/^generated-root-1-/), [SETUP_PASSWORD]: GOOD });
		// Nothing about authenticators is generated or asked for at deployment
		expect(Object.keys(h.deploys[0].written!)).toEqual([JWT_SECRET, SETUP_PASSWORD]);
	});

	it('removes the temporary secrets file, also when the deploy fails', async () => {
		const ok = harness(fresh());
		await run(ok, { [SETUP_PASSWORD]: GOOD });
		expect(ok.removed).toHaveLength(1);

		const failing = harness(fresh(), { deployFails: true });
		await expect(run(failing, { [SETUP_PASSWORD]: GOOD })).rejects.toThrow('deploy failed');
		expect(failing.removed).toHaveLength(1);
	});

	it('asks for the password once, in a terminal, when it was not supplied', async () => {
		const h = harness(fresh());
		let asked = 0;
		await run(h, {}, async () => (++asked, GOOD));
		expect(asked).toBe(1);
		expect(h.deploys[0].written?.[SETUP_PASSWORD]).toBe(GOOD);
	});

	it.each([
		['missing', undefined],
		['empty', ''],
		['too short', 'tiny-pw-0123'],
		['an example value', 'REPLACE_WITH_UNIQUE_PASSWORD_16_CHARS_MINIMUM'],
	])('refuses before changing anything when the password is %s', async (_label, password) => {
		const h = harness(fresh());
		const env: Record<string, string> = password === undefined ? {} : { [SETUP_PASSWORD]: password };
		const error = await refusal(run(h, env, async () => null));
		expect(['password-required', 'password-invalid']).toContain(error.code);
		expect(h.deploys).toHaveLength(0);
		expect(h.calls).not.toContain('write');
		if (password) expect(error.message).not.toContain(password);
	});

	it('works when the Worker does not exist yet, and when the bucket is empty and new', async () => {
		const h = harness({ secrets: null, bucket: false, owner: false, marker: false });
		expect((await run(h, { [SETUP_PASSWORD]: GOOD })).mode).toBe('fresh');
		expect(h.calls).not.toContain('objectExists:auth/owner.json');
	});

	it('only sends the root when the platform already holds the password as a secret (Deploy Button form)', async () => {
		const h = harness({ ...fresh(), secrets: [SETUP_PASSWORD] });
		const result = await run(h);
		expect(result.uploaded).toEqual([JWT_SECRET]);
		expect(h.deploys[0].written).toEqual({ [JWT_SECRET]: expect.any(String) });
	});

	it('never puts a secret value into the log or the result', async () => {
		const h = harness(fresh());
		const result = await run(h, { [SETUP_PASSWORD]: GOOD });
		const text = JSON.stringify([result, h.logs]);
		expect(text).not.toContain(GOOD);
		expect(text).not.toContain('generated-root');
	});
});

describe('upgrade', () => {
	it('needs no password and uploads no secret: code only, other settings kept', async () => {
		const h = harness(installed());
		const result = await run(h);
		expect(result).toEqual({ mode: 'upgrade', uploaded: [] });
		expect(h.deploys).toEqual([{ secretsFile: null, keepVars: true, written: null }]);
		expect(h.calls).not.toContain('write');
	});

	it('ignores a password in the environment: the Owner is never touched', async () => {
		const h = harness(installed());
		await run(h, { [SETUP_PASSWORD]: GOOD });
		expect(h.deploys[0].secretsFile).toBeNull();
	});

	it('does not need the setup password secret to still exist', async () => {
		const h = harness({ ...installed(), secrets: [JWT_SECRET] });
		expect((await run(h)).mode).toBe('upgrade');
	});
});

describe('refusals that change nothing', () => {
	it('an Owner exists but the Worker has no root secret: never makes a replacement', async () => {
		const h = harness({ secrets: [SETUP_PASSWORD], bucket: true, owner: true, marker: true });
		expect((await refusal(run(h, { [SETUP_PASSWORD]: GOOD }))).code).toBe('root-missing');
		expect(h.deploys).toHaveLength(0);
	});

	it('the Worker does not exist but the bucket already has an Owner', async () => {
		const h = harness({ secrets: null, bucket: true, owner: true, marker: true });
		expect((await refusal(run(h, { [SETUP_PASSWORD]: GOOD }))).code).toBe('root-missing');
		expect(h.deploys).toHaveLength(0);
	});

	it('a setup marker with no Owner needs recovery, not a new install', async () => {
		const h = harness({ secrets: [JWT_SECRET], bucket: true, owner: false, marker: true });
		expect((await refusal(run(h, { [SETUP_PASSWORD]: GOOD }))).code).toBe('recovery-required');
		expect(h.deploys).toHaveLength(0);
	});

	it.each(['secretNames', 'bucketExists', 'objectExists'])('an error from %s is a refusal, not "nothing there"', async (failOn) => {
		const h = harness(installed(), { failOn });
		expect((await refusal(run(h, { [SETUP_PASSWORD]: GOOD }))).code).toBe('inspect-failed');
		expect(h.deploys).toHaveLength(0);
		expect(h.calls).not.toContain('write');
	});

	it('another install appearing while this one starts stops it before anything is uploaded', async () => {
		const h = harness(fresh(), { changeBeforeDeploy: { secrets: [JWT_SECRET] } });
		expect((await refusal(run(h, { [SETUP_PASSWORD]: GOOD }))).code).toBe('changed');
		expect(h.deploys).toHaveLength(0);
		expect(h.calls).not.toContain('write');
	});
});

describe('resuming an install that stopped early', () => {
	it('keeps the existing root and sets only the password', async () => {
		const h = harness({ secrets: [JWT_SECRET], bucket: true, owner: false, marker: false });
		const result = await run(h, { [SETUP_PASSWORD]: GOOD });
		expect(result).toEqual({ mode: 'resume', uploaded: [SETUP_PASSWORD] });
		expect(h.deploys[0].written).toEqual({ [SETUP_PASSWORD]: GOOD });
	});
});

describe('decision table and password check', () => {
	it('decides from facts alone', () => {
		const base = {
			workerExists: true,
			bucketExists: true,
			hasRoot: false,
			hasSetupPassword: false,
			ownerExists: false,
			markerExists: false,
		};
		expect(decide(base)).toBe('fresh');
		expect(decide({ ...base, hasRoot: true })).toBe('resume');
		expect(decide({ ...base, hasRoot: true, ownerExists: true })).toBe('upgrade');
		expect(() => decide({ ...base, ownerExists: true })).toThrow(DeployRefusal);
		expect(() => decide({ ...base, markerExists: true })).toThrow(DeployRefusal);
	});

	it('inspectTarget reports facts without writing', async () => {
		const h = harness(installed());
		expect(await inspectTarget(h.runner, { workerName: 'w', bucketName: 'b' })).toMatchObject({ hasRoot: true, ownerExists: true });
		expect(h.calls).not.toContain('deploy');
	});

	it('passwordProblem names the problem, never the value', () => {
		expect(passwordProblem(GOOD)).toBeNull();
		for (const bad of [undefined, '', 'tiny-pw-0123', 'change-me-change-me-change-me']) {
			expect(passwordProblem(bad as string)).toEqual(expect.any(String));
			if (typeof bad === 'string' && bad) expect(passwordProblem(bad)).not.toContain(bad);
		}
	});
});
