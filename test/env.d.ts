// Test-only additions to the Worker's Env (global and Cloudflare namespace, which `cloudflare:test` uses).
// TOTP_SECRETS belongs to the legacy protocol and is removed in TASK-28.
declare namespace Cloudflare {
	interface Env {
		TOTP_SECRETS?: string;
	}
}

interface Env {
	TOTP_SECRETS?: string;
}
