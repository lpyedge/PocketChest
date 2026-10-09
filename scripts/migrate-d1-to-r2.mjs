#!/usr/bin/env node
/**
 * One-time migration from the D1-backed version of PocketChest to R2-only storage.
 *
 * File content already lives in R2 under {sessionId}/{fileId} and is not touched.
 * This script reads the D1 tables and writes the new index objects next to it:
 *   - completed sessions -> codes/{CODE} manifest (+ expiry/{expiresAt}/{CODE} unless permanent)
 *   - incomplete sessions -> pending/{createdAt}/{sessionId}, so the cron job removes them after 48h
 * Chests that already expired are migrated too; the next cleanup run deletes them and their files.
 *
 * Usage:
 *   node scripts/migrate-d1-to-r2.mjs --database-id <id> [--database-name pocket-chest] \
 *     [--bucket pocket-chest] (--remote | --local) [--dry-run]
 *
 * Run it after deploying the R2-only Worker. Retrieval codes keep working; anyone holding a
 * download link from before the migration just needs to open the retrieval code again.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function parseArgs(argv) {
	const args = { databaseName: 'pocket-chest', bucket: 'pocket-chest', dryRun: false, target: null, databaseId: null };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--database-id') args.databaseId = argv[++i];
		else if (arg === '--database-name') args.databaseName = argv[++i];
		else if (arg === '--bucket') args.bucket = argv[++i];
		else if (arg === '--remote' || arg === '--local') args.target = arg;
		else if (arg === '--dry-run') args.dryRun = true;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	if (!args.databaseId || !args.target) {
		throw new Error('Required: --database-id <id> and one of --remote / --local');
	}
	return args;
}

function timestampSegment(timestamp) {
	return String(timestamp).padStart(10, '0');
}

function fileExtension(filename) {
	const lastDot = filename.lastIndexOf('.');
	return lastDot > 0 ? filename.substring(lastDot + 1) : null;
}

const args = parseArgs(process.argv.slice(2));
const workDir = mkdtempSync(join(tmpdir(), 'pocketchest-migrate-'));

// A throwaway Wrangler config that still has the D1 binding the main config no longer declares
const configPath = join(workDir, 'wrangler.json');
writeFileSync(
	configPath,
	JSON.stringify({
		name: 'pocket-chest-migration',
		compatibility_date: '2025-08-13',
		d1_databases: [{ binding: 'DB', database_name: args.databaseName, database_id: args.databaseId }],
		r2_buckets: [{ binding: 'R2_STORAGE', bucket_name: args.bucket }],
	}),
);

// With --local, use the project's .wrangler/state (what `wrangler dev` uses), not one next to the temp config
const targetArgs = args.target === '--local' ? ['--local', '--persist-to', '.wrangler/state'] : ['--remote'];

function wrangler(wranglerArgs) {
	return execFileSync('npx', ['wrangler', ...wranglerArgs, '--config', configPath, ...targetArgs], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'inherit'],
	});
}

function query(sql) {
	const output = wrangler(['d1', 'execute', args.databaseName, '--json', '--command', sql]);
	// Wrangler may print notices (e.g. about proxies) before the JSON
	return JSON.parse(output.slice(output.indexOf('[')))[0].results;
}

function putObject(key, body, contentType) {
	const file = join(workDir, 'object');
	writeFileSync(file, body);
	const typeArgs = contentType ? ['--content-type', contentType] : [];
	wrangler(['r2', 'object', 'put', `${args.bucket}/${key}`, '--file', file, ...typeArgs]);
}

try {
	const sessions = query('SELECT session_id, retrieval_code, upload_complete, expiry_date, created_at FROM sessions');
	const files = query(
		'SELECT file_id, session_id, original_filename, mime_type, file_size, is_text FROM files ORDER BY created_at, original_filename',
	);

	const filesBySession = new Map();
	for (const file of files) {
		const list = filesBySession.get(file.session_id) ?? [];
		list.push({
			fileId: file.file_id,
			filename: file.original_filename,
			size: file.file_size,
			mimeType: file.mime_type,
			isText: Boolean(file.is_text),
			fileExtension: fileExtension(file.original_filename),
		});
		filesBySession.set(file.session_id, list);
	}

	const objects = [];
	for (const session of sessions) {
		if (session.upload_complete && session.retrieval_code) {
			const manifest = {
				version: 1,
				sessionId: session.session_id,
				createdAt: session.created_at,
				expiresAt: session.expiry_date ?? null,
				files: filesBySession.get(session.session_id) ?? [],
			};
			objects.push({ key: `codes/${session.retrieval_code}`, body: JSON.stringify(manifest), contentType: 'application/json' });
			if (manifest.expiresAt !== null) {
				objects.push({ key: `expiry/${timestampSegment(manifest.expiresAt)}/${session.retrieval_code}`, body: '' });
			}
		} else {
			objects.push({ key: `pending/${timestampSegment(session.created_at)}/${session.session_id}`, body: '' });
		}
	}

	const completed = sessions.filter((s) => s.upload_complete && s.retrieval_code).length;
	console.log(`Found ${sessions.length} sessions (${completed} completed) and ${files.length} files`);
	console.log(`${args.dryRun ? 'Would write' : 'Writing'} ${objects.length} index objects to ${args.bucket} (${args.target})`);

	for (const object of objects) {
		console.log(`  ${object.key}`);
		if (!args.dryRun) {
			putObject(object.key, object.body, object.contentType);
		}
	}

	console.log(args.dryRun ? 'Dry run finished, nothing written.' : 'Migration finished. The D1 database is no longer used.');
} finally {
	rmSync(workDir, { recursive: true, force: true });
}
