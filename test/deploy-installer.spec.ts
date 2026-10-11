import { describe, it, expect } from 'vitest';
import { ARMED_SECRET, decide, DeployRefusal, install, inspectTarget, JWT_SECRET, SETUP_PASSWORD } from '../scripts/deploy-core.mjs';

interface World {
	secrets: string[] | null; // null: the Worker does not exist yet
	bucket: boolean;
	owner: boolean;
	marker: boolean;
}

interface Privacy {
	publicDevUrl: boolean;
	customDomains: number;
}

// A pretend Cloudflare: answers from `world`, records every change, and can be told to fail
function harness(
	world: World,
	options: {
		failOn?: string;
		deployFails?: boolean;
		changeBeforeDeploy?: Partial<World>;
		createFails?: boolean;
		bucketStaysMissing?: boolean;
		privacy?: Privacy;
	} = {},
) {
	const calls: string[] = [];
	const deploys: { secretsFile: string | null; keepVars: boolean; written: Record<string, string> | null }[] = [];
	const store = new Map<string, Record<string, string>>();
	const created: string[] = [];
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
		async createBucket(bucket: string) {
			calls.push('createBucket');
			if (options.createFails) throw new Error('R2 is not enabled on this account');
			created.push(bucket);
			if (!options.bucketStaysMissing) world.bucket = true;
		},
		async bucketPrivacy(): Promise<Privacy> {
			calls.push('bucketPrivacy');
			if (options.failOn === 'bucketPrivacy') throw new Error('API error 403');
			return options.privacy ?? { publicDevUrl: false, customDomains: 0 };
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
	return { runner, files, calls, deploys, removed, logs, created, log: (line: string) => logs.push(line) };
}

function run(h: ReturnType<typeof harness>) {
	let roots = 0;
	return install({
		runner: h.runner,
		files: h.files,
		workerName: 'pocket-chest',
		bucketName: 'pocket-chest',
		generateRoot: () => `generated-root-${++roots}-${'x'.repeat(40)}`,
		log: h.log,
	});
}

const fresh = (): World => ({ secrets: null, bucket: true, owner: false, marker: false });
const installed = (): World => ({ secrets: [JWT_SECRET, SETUP_PASSWORD], bucket: true, owner: true, marker: true });

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
	it('asks for nothing and uploads only the generated root and the arming flag, exactly once', async () => {
		const h = harness(fresh());
		const result = await run(h);
		expect(result).toMatchObject({ mode: 'fresh', uploaded: [JWT_SECRET, ARMED_SECRET] });
		expect(h.deploys).toHaveLength(1);
		expect(Object.keys(h.deploys[0].written ?? {}).sort()).toEqual([ARMED_SECRET, JWT_SECRET].sort());
		expect(h.deploys[0].keepVars).toBe(false);
	});

	it('never uploads the Owner password, even when the environment of an old setup still has it', async () => {
		const h = harness(fresh());
		await run(h);
		expect(h.deploys[0].written).not.toHaveProperty(SETUP_PASSWORD);
	});

	it('removes the temporary secrets file, also when the deploy fails', async () => {
		const h = harness(fresh(), { deployFails: true });
		await expect(run(h)).rejects.toThrow('deploy failed');
		expect(h.removed).toHaveLength(1);
	});

	it('creates the bucket when it is positively absent, checks it, and only then checks privacy', async () => {
		const h = harness({ secrets: null, bucket: false, owner: false, marker: false });
		expect(await run(h)).toMatchObject({ mode: 'fresh', uploaded: [JWT_SECRET, ARMED_SECRET] });
		expect(h.created).toEqual(['pocket-chest']);
		expect(h.calls.indexOf('createBucket')).toBeLessThan(h.calls.indexOf('bucketPrivacy'));
		expect(h.calls.indexOf('bucketPrivacy')).toBeLessThan(h.calls.indexOf('write'));
	});

	it('refuses when R2 cannot create the bucket, and arms nothing', async () => {
		const h = harness({ secrets: null, bucket: false, owner: false, marker: false }, { createFails: true });
		expect((await refusal(run(h))).code).toBe('bucket-create-failed');
		expect(h.deploys).toHaveLength(0);
		expect(h.calls).not.toContain('write');
	});

	it('refuses when the bucket does not show up after creation', async () => {
		const h = harness({ secrets: null, bucket: false, owner: false, marker: false }, { bucketStaysMissing: true });
		expect((await refusal(run(h))).code).toBe('bucket-create-failed');
		expect(h.deploys).toHaveLength(0);
	});

	it('works when the Worker does not exist yet', async () => {
		const h = harness({ secrets: null, bucket: true, owner: false, marker: false });
		expect(await run(h)).toMatchObject({ mode: 'fresh', uploaded: [JWT_SECRET, ARMED_SECRET] });
		expect(h.created).toEqual([]);
	});

	it('never puts a secret value into the log or the result', async () => {
		const h = harness(fresh());
		const result = await run(h);
		expect(JSON.stringify([result, h.logs])).not.toMatch(/generated-root-\d+-x/);
	});
});

describe('bucket privacy gate: nothing is armed unless the bucket is proven private', () => {
	it.each([
		['r2.dev access is on', { publicDevUrl: true, customDomains: 0 }],
		['a custom domain is attached', { publicDevUrl: false, customDomains: 1 }],
	])('refuses when %s, and uploads and deploys nothing', async (_label, privacy) => {
		const h = harness(fresh(), { privacy });
		expect((await refusal(run(h))).code).toBe('bucket-not-private');
		expect(h.deploys).toHaveLength(0);
		expect(h.calls).not.toContain('write');
	});

	it('refuses when the privacy answer is unavailable (403, network, unclear)', async () => {
		const h = harness(fresh(), { failOn: 'bucketPrivacy' });
		expect((await refusal(run(h))).code).toBe('inspect-failed');
		expect(h.deploys).toHaveLength(0);
	});

	it('checks privacy on resume too, before the arming flag is uploaded', async () => {
		const h = harness(
			{ secrets: [JWT_SECRET], bucket: true, owner: false, marker: false },
			{ privacy: { publicDevUrl: true, customDomains: 0 } },
		);
		expect((await refusal(run(h))).code).toBe('bucket-not-private');
		expect(h.deploys).toHaveLength(0);
	});

	it('an upgrade is not blocked by the privacy answer and does not ask for it', async () => {
		const h = harness(installed(), { failOn: 'bucketPrivacy' });
		expect(await run(h)).toMatchObject({ mode: 'upgrade', uploaded: [] });
		expect(h.calls).not.toContain('bucketPrivacy');
	});
});

describe('upgrade', () => {
	it('needs no input and uploads no secret: code only, other settings kept', async () => {
		const h = harness(installed());
		expect(await run(h)).toMatchObject({ mode: 'upgrade', uploaded: [] });
		expect(h.deploys).toEqual([{ secretsFile: null, keepVars: true, written: null }]);
	});

	it('does not need the old setup password secret to still exist', async () => {
		const h = harness({ secrets: [JWT_SECRET], bucket: true, owner: true, marker: true });
		expect(await run(h)).toMatchObject({ mode: 'upgrade', uploaded: [] });
	});
});

describe('refusals that change nothing', () => {
	it('an Owner exists but the Worker has no root secret: never makes a replacement', async () => {
		const h = harness({ secrets: [], bucket: true, owner: true, marker: true });
		expect((await refusal(run(h))).code).toBe('root-missing');
		expect(h.deploys).toHaveLength(0);
	});

	it('the Worker does not exist but the bucket already has an Owner', async () => {
		const h = harness({ secrets: null, bucket: true, owner: true, marker: true });
		expect((await refusal(run(h))).code).toBe('root-missing');
		expect(h.deploys).toHaveLength(0);
	});

	it('a setup marker with no Owner needs recovery, not a new install', async () => {
		const h = harness({ secrets: [JWT_SECRET], bucket: true, owner: false, marker: true });
		expect((await refusal(run(h))).code).toBe('recovery-required');
		expect(h.deploys).toHaveLength(0);
	});

	it('a Worker that exists without its bucket is refused, never recreated as a fresh install', async () => {
		const h = harness({ secrets: [], bucket: false, owner: false, marker: false });
		expect((await refusal(run(h))).code).toBe('bucket-missing');
		expect(h.calls).not.toContain('createBucket');
	});

	it.each(['secretNames', 'bucketExists', 'objectExists'])('an error from %s is a refusal, not "nothing there"', async (failOn) => {
		const h = harness(installed(), { failOn });
		expect((await refusal(run(h))).code).toBe('inspect-failed');
		expect(h.deploys).toHaveLength(0);
		expect(h.calls).not.toContain('write');
	});

	it('another install appearing while this one starts stops it before anything is uploaded', async () => {
		const h = harness(fresh(), { changeBeforeDeploy: { secrets: [JWT_SECRET] } });
		expect((await refusal(run(h))).code).toBe('changed');
		expect(h.deploys).toHaveLength(0);
		expect(h.calls).not.toContain('write');
	});
});

describe('resuming an install that stopped early', () => {
	it('keeps the existing root and uploads only the arming flag', async () => {
		const h = harness({ secrets: [JWT_SECRET], bucket: true, owner: false, marker: false });
		expect(await run(h)).toMatchObject({ mode: 'resume', uploaded: [ARMED_SECRET] });
		expect(Object.keys(h.deploys[0].written ?? {})).toEqual([ARMED_SECRET]);
	});
});

describe('decision table', () => {
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
		expect(() => decide({ ...base, bucketExists: false, workerExists: true })).toThrow(DeployRefusal);
	});

	it('inspectTarget reports facts without writing', async () => {
		const h = harness(installed());
		expect(await inspectTarget(h.runner, { workerName: 'w', bucketName: 'b' })).toMatchObject({ hasRoot: true, ownerExists: true });
		expect(h.calls).not.toContain('deploy');
	});
});
