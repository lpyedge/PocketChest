import { describe, it, expect } from 'vitest';
import recovery from '../../docs/RECOVERY.md?raw';
import recoveryZh from '../../docs/RECOVERY.zh-Hant.md?raw';
import recoveryJa from '../../docs/RECOVERY.ja.md?raw';
import deployment from '../../DEPLOYMENT.md?raw';
import deploymentZh from '../../DEPLOYMENT.zh-Hant.md?raw';
import deploymentJa from '../../DEPLOYMENT.ja.md?raw';
import operations from '../../docs/OPERATIONS.md?raw';

const ALL = { 'RECOVERY.md': recovery, 'RECOVERY.zh-Hant.md': recoveryZh, 'RECOVERY.ja.md': recoveryJa };

describe('recovery documentation accuracy', () => {
	it('is available in English (default), Traditional Chinese and Japanese, and each links to the others', () => {
		for (const [name, text] of Object.entries(ALL)) {
			expect(text, name).toContain('[English](RECOVERY.md)');
			expect(text, name).toContain('[繁體中文](RECOVERY.zh-Hant.md)');
			expect(text, name).toContain('[日本語](RECOVERY.ja.md)');
		}
	});

	it('states the same facts in every language: the same commands, paths and settings', () => {
		for (const [name, text] of Object.entries(ALL)) {
			expect(text, name).toContain('wrangler r2 object delete');
			expect(text, name).toContain('node scripts/recover-bootstrap.mjs --bucket pocket-chest');
			expect(text, name).toContain('auth/initial-owner-password.txt');
			expect(text, name).toContain('SETUP_ARMED');
			expect(text, name).toContain('HMAC-SHA256-KEYED-V1');
			expect(text, name).not.toMatch(/reset-owner-password\.mjs --bucket/);
			expect(text, name).not.toContain('不提供條件寫入');
		}
	});

	it('says plainly that the password cannot be reset offline in each language, and does not point at a tool that claims to', () => {
		expect(recovery).toContain('the password cannot be reset offline');
		expect(recoveryZh).toContain('不能離線重設密碼');
		expect(recoveryJa).toContain('パスワードはオフラインでリセットできません');
	});

	it('documents the first-owner recovery for an interrupted setup, and the docs that mention it point to the tool', () => {
		for (const [name, text] of Object.entries(ALL)) expect(text, name).toContain('scripts/recover-bootstrap.mjs');
		for (const doc of [deployment, deploymentZh, deploymentJa, operations]) {
			expect(doc).toContain('recover-bootstrap.mjs');
		}
	});
});
