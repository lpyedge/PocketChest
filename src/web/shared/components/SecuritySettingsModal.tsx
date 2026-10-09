import { useEffect, useState } from 'react';
import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
import { authApi, AuthRequestError, Rotation, SecurityStatus } from '@/lib/auth-api';
import { describeAuthError } from '@/components/AuthMethodPicker';

type Method = 'password' | 'totp' | 'passkey';

interface SecuritySettingsModalProps {
	csrfToken: string;
	onRotated: (csrfToken: string) => void;
	onClose: () => void;
	onSignedOut: () => void;
}

// An action waiting for a re-entry. `required` is set when the action only makes sense with that method.
interface PendingAction {
	run: () => Promise<void>;
	required: Method | null;
}

function statusLabel(item: { configured: boolean; enabled: boolean }): string {
	if (!item.configured) return 'Not set up';
	return item.enabled ? 'On' : 'Off (set up)';
}

export function SecuritySettingsModal({ csrfToken, onRotated, onClose, onSignedOut }: SecuritySettingsModalProps) {
	const [status, setStatus] = useState<SecurityStatus | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [pending, setPending] = useState<PendingAction | null>(null);
	const [newPassword, setNewPassword] = useState('');
	const [confirmPassword, setConfirmPassword] = useState('');
	const [totpSetup, setTotpSetup] = useState<{ challenge: string; otpauthUri: string } | null>(null);
	const [totpCode, setTotpCode] = useState('');
	const [reauthPassword, setReauthPassword] = useState('');
	const [reauthCode, setReauthCode] = useState('');
	const [csrf, setCsrf] = useState(csrfToken);

	const refresh = async () => {
		try {
			setStatus(await authApi.security());
		} catch (error) {
			setMessage(describeAuthError(error));
		}
	};

	useEffect(() => {
		refresh();
	}, []);

	// Runs an action; a missing or old re-entry opens the re-entry panel, and the action then runs again
	const attempt = async (run: (token: string) => Promise<Rotation | void>, required: Method | null = null) => {
		setBusy(true);
		setMessage(null);
		try {
			const result = await run(csrf);
			if (result && 'csrfToken' in result) {
				setCsrf(result.csrfToken);
				onRotated(result.csrfToken);
			}
			await refresh();
		} catch (error) {
			if (error instanceof AuthRequestError && (error.code === 'REAUTH_REQUIRED' || error.code === 'REAUTH_METHOD_REQUIRED')) {
				setPending({ run: () => attempt(run, required), required });
			} else if (error instanceof AuthRequestError && error.status === 409) {
				setMessage(`${error.message} The settings are reloaded below.`);
				await refresh();
			} else {
				setMessage(describeAuthError(error));
			}
		} finally {
			setBusy(false);
		}
	};

	// Re-entry with a method the owner has set up; with `required`, only that method is offered
	const reenter = async (method: Method, action: () => Promise<void>) => {
		setBusy(true);
		setMessage(null);
		try {
			if (method === 'password') {
				const response = await authApi.reauthPassword(csrf, reauthPassword);
				setReauthPassword('');
				void response;
			} else if (method === 'totp') {
				await authApi.reauthTotp(csrf, reauthCode);
				setReauthCode('');
			} else {
				const options = await authApi.reauthPasskeyOptions(csrf);
				const response = await startAuthentication({ optionsJSON: options });
				await authApi.reauthPasskeyVerify(csrf, options.challenge, response);
			}
			setPending(null);
			await action();
		} catch (error) {
			setMessage(describeAuthError(error));
		} finally {
			setBusy(false);
		}
	};

	const offeredMethods = (required: Method | null): Method[] => {
		if (!status) return [];
		const all: Method[] = ['password', 'totp', 'passkey'];
		return all.filter((method) => status.methods[method].configured && (required === null || required === method));
	};

	const toggle = (method: Method, enabled: boolean) =>
		attempt((token) => authApi.setMethod(token, method, enabled), enabled ? method : null);

	const registerPasskey = () =>
		attempt(async (token) => {
			const options = await authApi.passkeyRegisterOptions(token);
			const response = await startRegistration({ optionsJSON: options });
			await authApi.passkeyRegisterVerify(token, options.challenge, response, 'This device');
		});

	const removePasskey = (id: string, label: string) => {
		if (!window.confirm(`Remove the passkey "${label}"? You will not be able to sign in with it.`)) return;
		attempt((token) => authApi.passkeyRemove(token, id));
	};

	const submitTotpCode = () =>
		attempt(async (token) => {
			if (!totpSetup) return;
			const rotated = await authApi.totpConfirm(token, totpSetup.challenge, totpCode);
			setTotpSetup(null);
			setTotpCode('');
			return rotated;
		});

	if (!status) {
		return (
			<Dialog title="Security settings" onClose={onClose}>
				<p className="text-gray-600">{message ?? 'Loading...'}</p>
			</Dialog>
		);
	}

	return (
		<Dialog title="Security settings" onClose={onClose}>
			{message && <p className="mb-4 text-sm text-red-700">{message}</p>}

			{pending && (
				<section className="mb-6 p-4 border border-amber-300 bg-amber-50 rounded-lg space-y-3">
					<p className="text-sm text-gray-800">Confirm it is you to continue{pending.required ? ` with ${pending.required}` : ''}.</p>
					{offeredMethods(pending.required).map((method) => {
						if (method === 'password') {
							return (
								<form
									key={method}
									className="flex gap-2"
									onSubmit={(event) => {
										event.preventDefault();
										reenter('password', pending.run);
									}}
								>
									<input
										type="password"
										aria-label="Password"
										value={reauthPassword}
										onChange={(event) => setReauthPassword(event.target.value)}
										className="flex-1 border border-gray-300 rounded px-3 py-2"
									/>
									<button type="submit" disabled={busy} className="px-4 py-2 bg-blue-500 text-white rounded disabled:opacity-50">
										Confirm with password
									</button>
								</form>
							);
						}
						if (method === 'totp') {
							return (
								<form
									key={method}
									className="flex gap-2"
									onSubmit={(event) => {
										event.preventDefault();
										reenter('totp', pending.run);
									}}
								>
									<input
										inputMode="numeric"
										aria-label="Authenticator code"
										maxLength={6}
										value={reauthCode}
										onChange={(event) => setReauthCode(event.target.value)}
										className="flex-1 border border-gray-300 rounded px-3 py-2"
									/>
									<button type="submit" disabled={busy} className="px-4 py-2 bg-blue-500 text-white rounded disabled:opacity-50">
										Confirm with authenticator
									</button>
								</form>
							);
						}
						return (
							<button
								key={method}
								type="button"
								disabled={busy}
								onClick={() => reenter('passkey', pending.run)}
								className="px-4 py-2 bg-gray-800 text-white rounded disabled:opacity-50"
							>
								Confirm with passkey
							</button>
						);
					})}
					<button type="button" onClick={() => setPending(null)} className="text-sm text-gray-600 underline">
						Cancel
					</button>
				</section>
			)}

			<Section title="Password" item={status.methods.password} label={statusLabel(status.methods.password)}>
				<ToggleButton item={status.methods.password} busy={busy} onToggle={(enabled) => toggle('password', enabled)} />
				<form
					className="mt-4 space-y-2"
					onSubmit={(event) => {
						event.preventDefault();
						const next = newPassword;
						const confirm = confirmPassword;
						setNewPassword('');
						setConfirmPassword('');
						attempt((token) => authApi.changePassword(token, next, confirm));
					}}
				>
					<input
						type="password"
						aria-label="New password"
						placeholder="New password (at least 16 characters)"
						autoComplete="new-password"
						value={newPassword}
						onChange={(event) => setNewPassword(event.target.value)}
						className="w-full border border-gray-300 rounded px-3 py-2"
					/>
					<input
						type="password"
						aria-label="Confirm new password"
						placeholder="Confirm new password"
						autoComplete="new-password"
						value={confirmPassword}
						onChange={(event) => setConfirmPassword(event.target.value)}
						className="w-full border border-gray-300 rounded px-3 py-2"
					/>
					<button type="submit" disabled={busy} className="px-4 py-2 bg-gray-800 text-white rounded disabled:opacity-50">
						Change password
					</button>
					<p className="text-xs text-gray-500">Changing the password ends every other signed-in session.</p>
				</form>
			</Section>

			<Section title="Authenticator app" item={status.methods.totp} label={statusLabel(status.methods.totp)}>
				<ToggleButton item={status.methods.totp} busy={busy} onToggle={(enabled) => toggle('totp', enabled)} />
				{!totpSetup ? (
					<button
						type="button"
						disabled={busy}
						onClick={() =>
							attempt(async (token) => {
								const prepared = await authApi.totpPrepare(token);
								setTotpSetup({ challenge: prepared.challenge, otpauthUri: prepared.otpauthUri });
							})
						}
						className="mt-3 px-4 py-2 bg-gray-800 text-white rounded disabled:opacity-50"
					>
						{status.methods.totp.configured ? 'Replace authenticator' : 'Set up authenticator'}
					</button>
				) : (
					<div className="mt-3 space-y-2">
						<p className="text-sm text-gray-700">Add this key to your authenticator app, then enter the 6-digit code it shows.</p>
						<code className="block break-all bg-gray-100 p-2 rounded text-xs">{totpSetup.otpauthUri}</code>
						<form
							className="flex gap-2"
							onSubmit={(event) => {
								event.preventDefault();
								submitTotpCode();
							}}
						>
							<input
								inputMode="numeric"
								aria-label="New authenticator code"
								maxLength={6}
								value={totpCode}
								onChange={(event) => setTotpCode(event.target.value)}
								className="flex-1 border border-gray-300 rounded px-3 py-2"
							/>
							<button type="submit" disabled={busy} className="px-4 py-2 bg-blue-500 text-white rounded disabled:opacity-50">
								Confirm code
							</button>
						</form>
						<button type="button" onClick={() => setTotpSetup(null)} className="text-sm text-gray-600 underline">
							Cancel (the current authenticator stays in use)
						</button>
					</div>
				)}
			</Section>

			<Section title="Passkeys" item={status.methods.passkey} label={statusLabel(status.methods.passkey)}>
				<ToggleButton item={status.methods.passkey} busy={busy} onToggle={(enabled) => toggle('passkey', enabled)} />
				<ul className="mt-3 space-y-2">
					{status.methods.passkey.credentials.map((credential) => (
						<li key={credential.id} className="flex items-center justify-between gap-2 text-sm">
							<span>
								{credential.label}
								<span className="text-gray-500">
									{' '}
									· added {new Date(credential.createdAt * 1000).toLocaleDateString()}
									{credential.lastUsedAt ? ` · last used ${new Date(credential.lastUsedAt * 1000).toLocaleDateString()}` : ''}
								</span>
							</span>
							<button
								type="button"
								disabled={busy}
								onClick={() => removePasskey(credential.id, credential.label)}
								className="text-red-700 hover:underline disabled:opacity-50"
							>
								Remove
							</button>
						</li>
					))}
				</ul>
				<button
					type="button"
					disabled={busy}
					onClick={registerPasskey}
					className="mt-3 px-4 py-2 bg-gray-800 text-white rounded disabled:opacity-50"
				>
					Add passkey
				</button>
				<p className="mt-2 text-xs text-gray-500">A new passkey is not used for sign-in until you switch the passkey method on.</p>
			</Section>

			<div className="mt-6 flex justify-between">
				<button
					type="button"
					onClick={async () => {
						try {
							await authApi.logout(csrf);
							onSignedOut();
						} catch (error) {
							setMessage(describeAuthError(error));
						}
					}}
					className="text-sm text-gray-700 underline"
				>
					Sign out
				</button>
				<button type="button" onClick={onClose} className="px-4 py-2 bg-gray-200 rounded">
					Close
				</button>
			</div>
		</Dialog>
	);
}

function ToggleButton({
	item,
	busy,
	onToggle,
}: {
	item: { configured: boolean; enabled: boolean };
	busy: boolean;
	onToggle: (enabled: boolean) => void;
}) {
	return (
		<button
			type="button"
			disabled={busy || (!item.enabled && !item.configured)}
			onClick={() => onToggle(!item.enabled)}
			className="px-4 py-2 border border-gray-400 rounded hover:bg-gray-50 disabled:opacity-50"
		>
			{item.enabled ? 'Turn off' : item.configured ? 'Turn on' : 'Set up first'}
		</button>
	);
}

function Section({ title, label, children }: { title: string; item: unknown; label: string; children: React.ReactNode }) {
	return (
		<section className="mb-6 border-b border-gray-200 pb-6">
			<div className="flex items-baseline justify-between">
				<h3 className="font-semibold text-gray-900">{title}</h3>
				<span className="text-sm text-gray-600">{label}</span>
			</div>
			<div className="mt-3">{children}</div>
		</section>
	);
}

function Dialog({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
	return (
		<div
			className="fixed inset-0 bg-black/40 flex items-start justify-center p-4 overflow-y-auto z-50"
			role="dialog"
			aria-modal="true"
			aria-label={title}
		>
			<div className="bg-white rounded-lg shadow-xl w-full max-w-lg p-6 mt-10">
				<div className="flex justify-between items-center mb-4">
					<h2 className="text-xl font-bold text-gray-900">{title}</h2>
					<button type="button" onClick={onClose} aria-label="Close" className="text-gray-500 hover:text-gray-800">
						✕
					</button>
				</div>
				{children}
			</div>
		</div>
	);
}
