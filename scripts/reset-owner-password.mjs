#!/usr/bin/env node
// Offline owner password reset: not supported. The password record is keyed with a secret only the Worker holds, so
// this machine cannot write one the Worker would accept. The tool says so and exits without reading or writing
// anything. See docs/RECOVERY.md.
import { OFFLINE_RESET_UNSUPPORTED, recoverPassword } from './recovery-core.mjs';

recoverPassword().catch(() => {
	console.error(OFFLINE_RESET_UNSUPPORTED);
	process.exitCode = 1;
});
