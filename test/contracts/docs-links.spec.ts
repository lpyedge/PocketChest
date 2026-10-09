/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest';

// The README and deployment guide exist in three languages, and they point at each other, at the docs and at the
// screenshots. This keeps those links honest: a renamed heading or a missing image fails here, not for a reader.
const markdown = import.meta.glob(['../../*.md', '../../docs/*.md'], { query: '?raw', import: 'default', eager: true }) as Record<
	string,
	string
>;
const images = Object.keys(import.meta.glob('../../assets/screenshots/*.png', { query: '?url', eager: false }));

const files = new Map(Object.entries(markdown).map(([path, text]) => [path.replace('../../', ''), text]));

// GitHub's heading anchors: lower case, punctuation dropped (letters of any script kept), spaces become hyphens
const slug = (heading: string) =>
	heading
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\p{M}\- _]/gu, '')
		.replace(/ /g, '-');

function anchorsOf(text: string): Set<string> {
	const withoutCode = text.replace(/```[\s\S]*?```/g, '');
	return new Set([...withoutCode.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => slug(match[1])));
}

const REPOSITORY = 'https://github.com/lpyedge/PocketChest';
const READMES = ['README.md', 'README.zh-Hant.md', 'README.ja.md'];
const GUIDES = ['DEPLOYMENT.md', 'DEPLOYMENT.zh-Hant.md', 'DEPLOYMENT.ja.md'];

describe('docs: placeholders and the deploy button', () => {
	it('finds the documents', () => {
		for (const name of [...READMES, ...GUIDES, 'docs/OPERATIONS.md', 'docs/ARCHITECTURE.md', 'docs/SCREENSHOTS.md']) {
			expect(files.has(name), name).toBe(true);
		}
	});

	it('keeps no placeholder repository name anywhere in the documents', () => {
		for (const [name, text] of files) expect(text, name).not.toMatch(/YOUR_GITHUB_USERNAME|YOUR_USERNAME/);
	});

	it('points every deploy button at this repository', () => {
		for (const name of [...READMES, ...GUIDES]) {
			const text = files.get(name)!;
			expect(text, name).toContain(`https://deploy.workers.cloudflare.com/?url=${REPOSITORY}`);
			for (const match of text.matchAll(/deploy\.workers\.cloudflare\.com\/\?url=([^)\s]+)/g)) expect(match[1], name).toBe(REPOSITORY);
		}
	});

	it('links each language to the other two', () => {
		for (const group of [READMES, GUIDES]) {
			for (const name of group) {
				const text = files.get(name)!;
				for (const other of group) expect(text, `${name} → ${other}`).toContain(`(${other})`);
			}
		}
	});
});

describe('docs: every relative link, anchor and image resolves', () => {
	for (const [name, text] of files) {
		if (!READMES.includes(name) && !GUIDES.includes(name) && !name.startsWith('docs/')) continue;
		const directory = name.includes('/') ? name.slice(0, name.lastIndexOf('/') + 1) : '';
		const prose = text.replace(/```[\s\S]*?```/g, '');

		it(`${name}: links to documents and headings`, () => {
			for (const match of prose.matchAll(/\]\(([^)\s]+)\)/g)) {
				const target = match[1];
				if (/^(https?:|mailto:)/.test(target)) continue;
				const [path, anchor] = target.split('#');
				const resolved = path === '' ? name : new URL(path, `http://x/${directory}`).pathname.slice(1);
				if (resolved.endsWith('.md')) {
					expect(files.has(resolved), `${name}: ${target}`).toBe(true);
					if (anchor) expect(anchorsOf(files.get(resolved)!).has(decodeURIComponent(anchor)), `${name}: ${target}`).toBe(true);
				}
			}
		});

		it(`${name}: images exist`, () => {
			for (const match of text.matchAll(/(?:src="|!\[[^\]]*\]\()(assets\/[^")\s]+)/g)) {
				const exists = images.some((path) => path.endsWith(match[1].replace('assets/', '/assets/')));
				expect(exists, `${name}: ${match[1]}`).toBe(true);
			}
		});
	}

	it('every screenshot a README shows exists for its own language', () => {
		for (const [name, lang] of [
			['README.md', 'en'],
			['README.zh-Hant.md', 'zh-Hant'],
			['README.ja.md', 'ja'],
		] as const) {
			const shown = [...files.get(name)!.matchAll(/assets\/screenshots\/([^"]+)\.png/g)].map((match) => match[1]);
			expect(shown.length, name).toBeGreaterThanOrEqual(6);
			for (const shot of shown) expect(shot.endsWith(`-${lang}`) || shot.endsWith(`-${lang}-mobile`), `${name}: ${shot}`).toBe(true);
		}
	});
});
