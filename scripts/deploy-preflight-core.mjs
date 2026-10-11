// Offline upgrade guard: compares the configuration an installation runs with now against the one an upgrade
// would deploy, and refuses when the instance identity would change. No network, no Cloudflare API, no R2.

// jsonc -> value: drop comments (keeping text inside strings) and trailing commas
export function parseJsonc(text) {
	const json = text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_, kept) => kept ?? '').replace(/,(\s*[}\]])/g, '$1');
	return JSON.parse(json);
}

const routeKey = (route) => (typeof route === 'string' ? route : JSON.stringify(Object.entries(route).sort()));

// The parts of a wrangler configuration that identify one installation. Secret values never appear here: only names.
export function snapshot(config, secretNames = []) {
	const vars = config.vars ?? {};
	return {
		name: config.name ?? null,
		buckets: Object.fromEntries((config.r2_buckets ?? []).map((b) => [b.binding, b.bucket_name ?? null])),
		routes: [...(config.routes ?? []).map(routeKey), ...(config.route ? [routeKey(config.route)] : [])].sort(),
		workersDev: config.workers_dev ?? true,
		bootstrapEnabled: vars.BOOTSTRAP_ENABLED ?? null,
		passkeyRpId: vars.PASSKEY_RP_ID ?? null,
		secrets: [...new Set(secretNames)].sort(),
	};
}

// Returns a list of plain-language problems; empty means the upgrade keeps the installation's identity.
export function compare(current, candidate) {
	const problems = [];
	const same = (field, label) => {
		if (current[field] !== candidate[field])
			problems.push(`${label} would change from ${JSON.stringify(current[field])} to ${JSON.stringify(candidate[field])}`);
	};
	same('name', 'Worker name');
	same('passkeyRpId', 'PASSKEY_RP_ID');

	for (const binding of new Set([...Object.keys(current.buckets), ...Object.keys(candidate.buckets)])) {
		if (current.buckets[binding] !== candidate.buckets[binding])
			problems.push(
				`R2 binding ${binding} would point to ${JSON.stringify(candidate.buckets[binding] ?? null)} instead of ${JSON.stringify(current.buckets[binding] ?? null)}`,
			);
	}

	if (JSON.stringify(current.routes) !== JSON.stringify(candidate.routes))
		problems.push(`routes would change from ${JSON.stringify(current.routes)} to ${JSON.stringify(candidate.routes)}`);
	if (current.workersDev !== candidate.workersDev) problems.push('workers_dev would change');

	// Setup is closed once the Owner exists; an upgrade must never turn it back on.
	if (current.bootstrapEnabled !== 'true' && candidate.bootstrapEnabled === 'true')
		problems.push('BOOTSTRAP_ENABLED would change from off back to "true", which would reopen first-time setup');

	const kept = new Set(candidate.secrets);
	const dropped = current.secrets.filter((name) => !kept.has(name));
	if (current.secrets.length > 0 && candidate.secrets.length > 0 && dropped.length > 0)
		problems.push(`secret names no longer expected: ${dropped.join(', ')}`);

	return problems;
}

// Convenience for the command line and tests: two wrangler.jsonc texts in, a verdict out. Throws if either is unreadable.
export function evaluate(currentText, candidateText, currentSecrets = [], candidateSecrets = []) {
	const problems = compare(snapshot(parseJsonc(currentText), currentSecrets), snapshot(parseJsonc(candidateText), candidateSecrets));
	return { ok: problems.length === 0, problems };
}
