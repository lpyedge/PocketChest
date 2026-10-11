import { useState } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import { authApi, AuthMethodsStatus, AuthRequestError } from '@/lib/auth-api';
import { codeKeyFor } from '@/lib/errors';
import { MessageKey, useI18n } from '@/i18n/I18nProvider';

interface AuthMethodPickerProps {
	status: AuthMethodsStatus;
	onSignedIn: (csrfToken: string) => void;
}

// Explains a failed attempt in the current language. Lockouts show how long to wait, so the page never looks stuck.
// Server text is never shown: the code is looked up in the local table, and anything unknown gets a generic line.
export function describeAuthError(error: unknown, t: (key: MessageKey, params?: Record<string, string | number>) => string): string {
	if (error instanceof AuthRequestError) {
		if (error.status === 429 && error.retryAfter !== null) {
			return t('auth.locked', { seconds: error.retryAfter });
		}
		if (error.status === 429) {
			return t('auth.lockedNoTime');
		}
		return t(codeKeyFor(error.code) ?? 'auth.failed');
	}
	if (error instanceof DOMException && error.name === 'NotAllowedError') {
		return t('auth.passkeyCancelled');
	}
	return t('auth.failed');
}

export function AuthMethodPicker({ status, onSignedIn }: AuthMethodPickerProps) {
	const { t } = useI18n();
	const [password, setPassword] = useState('');
	const [code, setCode] = useState('');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const run = async (action: () => Promise<string>) => {
		setBusy(true);
		setError(null);
		try {
			onSignedIn(await action());
		} catch (caught) {
			setError(describeAuthError(caught, t));
		} finally {
			setBusy(false);
		}
	};

	// No owner yet: the page says why, and never offers to create one
	if (status.setup !== 'ready') {
		const messages = {
			initializing: 'auth.setupInitializing',
			'password-missing': 'auth.setupPasswordMissing',
			'recovery-required': 'auth.setupRecoveryRequired',
			failed: 'auth.setupFailed',
		} as const;
		return (
			<div className="space-y-3">
				<p role="alert" className="text-gray-700">
					{t(messages[status.setup])}
				</p>
				{(status.setup === 'initializing' || status.setup === 'failed') && (
					<button
						type="button"
						onClick={() => window.location.reload()}
						className="w-full py-2 border border-gray-300 rounded-lg text-gray-800 hover:bg-gray-50"
					>
						{t('auth.setupRetry')}
					</button>
				)}
			</div>
		);
	}

	const { password: passwordOn, totp: totpOn, passkey: passkeyOn } = status.methods;
	if (!passwordOn.enabled && !totpOn.enabled && !passkeyOn.enabled) {
		// Fail closed: with no usable method the page never falls back to open uploads
		return <p className="text-gray-700">{t('auth.noMethod')}</p>;
	}

	return (
		<div className="space-y-6">
			{passwordOn.enabled && (
				<form
					className="space-y-3"
					onSubmit={(event) => {
						event.preventDefault();
						const entered = password;
						setPassword('');
						run(async () => (await authApi.loginPassword(entered)).csrfToken);
					}}
				>
					<label className="block text-sm font-medium text-gray-700">
						{t('auth.password')}
						<input
							type="password"
							autoComplete="current-password"
							value={password}
							onChange={(event) => setPassword(event.target.value)}
							className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2"
							required
						/>
					</label>
					<button
						type="submit"
						disabled={busy}
						className="w-full py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600 font-semibold disabled:opacity-50"
					>
						{t('auth.passwordSubmit')}
					</button>
				</form>
			)}

			{totpOn.enabled && (
				<form
					className="space-y-3"
					onSubmit={(event) => {
						event.preventDefault();
						const entered = code;
						setCode('');
						run(async () => (await authApi.loginTotp(entered)).csrfToken);
					}}
				>
					<label className="block text-sm font-medium text-gray-700">
						{t('auth.code')}
						<input
							inputMode="numeric"
							autoComplete="one-time-code"
							maxLength={6}
							value={code}
							onChange={(event) => setCode(event.target.value)}
							className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2"
							required
						/>
					</label>
					<button
						type="submit"
						disabled={busy}
						className="w-full py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600 font-semibold disabled:opacity-50"
					>
						{t('auth.codeSubmit')}
					</button>
				</form>
			)}

			{passkeyOn.enabled && (
				<button
					type="button"
					disabled={busy}
					onClick={() =>
						run(async () => {
							const options = await authApi.passkeyLoginOptions();
							const response = await startAuthentication({ optionsJSON: options });
							return (await authApi.passkeyLoginVerify(options.challenge, response)).csrfToken;
						})
					}
					className="w-full py-3 bg-gray-800 text-white rounded-lg hover:bg-gray-900 font-semibold disabled:opacity-50"
				>
					{t('auth.passkeySubmit')}
				</button>
			)}

			{error && <p className="text-red-700 text-sm">{error}</p>}
		</div>
	);
}
