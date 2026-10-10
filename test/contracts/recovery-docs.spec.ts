import { describe, it, expect } from 'vitest';
import recovery from '../../docs/RECOVERY.md?raw';
import deployment from '../../DEPLOYMENT.md?raw';
import deploymentZh from '../../DEPLOYMENT.zh-Hant.md?raw';
import deploymentJa from '../../DEPLOYMENT.ja.md?raw';
import operations from '../../docs/OPERATIONS.md?raw';

describe('recovery documentation accuracy', () => {
	it('does not claim that R2 lacks conditional writes', () => {
		expect(recovery).not.toContain('不提供條件寫入');
		expect(recovery).toContain('wrangler r2 object delete');
	});

	it('says plainly that the password cannot be reset offline, and does not point at a tool that claims to', () => {
		expect(recovery).toContain('不能離線重設密碼');
		expect(recovery).toContain('Security settings');
		expect(recovery).not.toMatch(/reset-owner-password\.mjs --bucket/);
	});

	it('documents the first-owner recovery for an interrupted setup, and the docs that mention it point to the tool', () => {
		expect(recovery).toContain('scripts/recover-bootstrap.mjs');
		for (const doc of [deployment, deploymentZh, deploymentJa, operations]) {
			expect(doc).toContain('recover-bootstrap.mjs');
		}
	});
});
