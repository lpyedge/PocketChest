import { useEffect, useState } from 'react';
import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
import { authApi, AuthRequestError, Rotation, SecurityStatus } from '@/lib/auth-api';
import { describeAuthError } from '@/components/AuthMethodPicker';
import { useI18n } from '@/i18n/I18nProvider';

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

function statusLabel(
	item: { configured: boolean; enabled: boolean },
	t: (key: 'security.notSetUp' | 'security.on' | 'security.offSetUp') => string,
): string {
	if (!item.configured) return t('security.notSetUp');
	return item.enabled ? t('security.on') : t('security.offSetUp');
}

export function SecuritySettingsModal({ csrfToken, onRotated, onClose, onSignedOut }: SecuritySettingsModalProps) {
	const { t, locale } = useI18n();
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
			setMessage(describeAuthError(error, t));
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
				setMessage(t('security.conflict'));
				await refresh();
			} else {
				setMessage(describeAuthError(error, t));
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
			setMessage(describeAuthError(error, t));
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
			await authApi.passkeyRegisterVerify(token, options.challenge, response, t('security.thisDevice'));
		});

	const removePasskey = (id: string, label: string) => {
		if (!window.confirm(t('security.removeConfirm', { label }))) return;
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
			<Dialog title={t('security.title')} onClose={onClose}>
				<p className="text-gray-600">{message ?? t('common.loading')}</p>
			</Dialog>
		);
	}

	return (
		<Dialog title={t('security.title')} onClose={onClose}>
			{message && <p className="mb-4 text-sm text-red-700">{message}</p>}

			{pending && (
				<section className="mb-6 p-4 border border-amber-300 bg-amber-50 rounded-lg space-y-3">
					<p className="text-sm text-gray-800">
						{pending.required ? t('security.confirmTitleWith', { method: t(`method.${pending.required}`) }) : t('security.confirmTitle')}
					</p>
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
										aria-label={t('auth.password')}
										value={reauthPassword}
										onChange={(event) => setReauthPassword(event.target.value)}
										className="flex-1 border border-gray-300 rounded px-3 py-2"
									/>
									<button type="submit" disabled={busy} className="px-4 py-2 bg-blue-500 text-white rounded disabled:opacity-50">
										{t('security.confirmPassword')}
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
										aria-label={t('auth.code')}
										maxLength={6}
										value={reauthCode}
										onChange={(event) => setReauthCode(event.target.value)}
										className="flex-1 border border-gray-300 rounded px-3 py-2"
									/>
									<button type="submit" disabled={busy} className="px-4 py-2 bg-blue-500 text-white rounded disabled:opacity-50">
										{t('security.confirmAuthenticator')}
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
								{t('security.confirmPasskey')}
							</button>
						);
					})}
					<button type="button" onClick={() => setPending(null)} className="text-sm text-gray-600 underline">
						{t('common.cancel')}
					</button>
				</section>
			)}

			<Section title={t('auth.password')} item={status.methods.password} label={statusLabel(status.methods.password, t)}>
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
						aria-label={t('security.newPassword')}
						placeholder={t('security.newPasswordHelp')}
						autoComplete="new-password"
						value={newPassword}
						onChange={(event) => setNewPassword(event.target.value)}
						className="w-full border border-gray-300 rounded px-3 py-2"
					/>
					<input
						type="password"
						aria-label={t('security.confirmNewPassword')}
						placeholder={t('security.confirmNewPassword')}
						autoComplete="new-password"
						value={confirmPassword}
						onChange={(event) => setConfirmPassword(event.target.value)}
						className="w-full border border-gray-300 rounded px-3 py-2"
					/>
					<button type="submit" disabled={busy} className="px-4 py-2 bg-gray-800 text-white rounded disabled:opacity-50">
						{t('security.changePassword')}
					</button>
					<p className="text-xs text-gray-500">{t('security.changeNote')}</p>
				</form>
			</Section>

			<Section title={t('security.authenticatorSection')} item={status.methods.totp} label={statusLabel(status.methods.totp, t)}>
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
						{status.methods.totp.configured ? t('security.replaceAuthenticator') : t('security.setUpAuthenticator')}
					</button>
				) : (
					<div className="mt-3 space-y-2">
						<p className="text-sm text-gray-700">{t('security.addKey')}</p>
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
								aria-label={t('security.newCode')}
								maxLength={6}
								value={totpCode}
								onChange={(event) => setTotpCode(event.target.value)}
								className="flex-1 border border-gray-300 rounded px-3 py-2"
							/>
							<button type="submit" disabled={busy} className="px-4 py-2 bg-blue-500 text-white rounded disabled:opacity-50">
								{t('security.confirmCode')}
							</button>
						</form>
						<button type="button" onClick={() => setTotpSetup(null)} className="text-sm text-gray-600 underline">
							{t('security.cancelSetup')}
						</button>
					</div>
				)}
			</Section>

			<Section title={t('security.passkeysSection')} item={status.methods.passkey} label={statusLabel(status.methods.passkey, t)}>
				<ToggleButton item={status.methods.passkey} busy={busy} onToggle={(enabled) => toggle('passkey', enabled)} />
				<ul className="mt-3 space-y-2">
					{status.methods.passkey.credentials.map((credential) => (
						<li key={credential.id} className="flex items-center justify-between gap-2 text-sm">
							<span>
								{credential.label}
								<span className="text-gray-500">
									{' '}
									· {t('security.added', { date: new Date(credential.createdAt * 1000).toLocaleDateString(locale) })}
									{credential.lastUsedAt
										? ` · ${t('security.lastUsed', { date: new Date(credential.lastUsedAt * 1000).toLocaleDateString(locale) })}`
										: ''}
								</span>
							</span>
							<button
								type="button"
								disabled={busy}
								onClick={() => removePasskey(credential.id, credential.label)}
								className="text-red-700 hover:underline disabled:opacity-50"
							>
								{t('common.remove')}
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
					{t('security.addPasskey')}
				</button>
				<p className="mt-2 text-xs text-gray-500">{t('security.passkeyNote')}</p>
			</Section>

			<div className="mt-6 flex justify-between">
				<button
					type="button"
					onClick={async () => {
						try {
							await authApi.logout(csrf);
							onSignedOut();
						} catch (error) {
							setMessage(describeAuthError(error, t));
						}
					}}
					className="text-sm text-gray-700 underline"
				>
					{t('upload.signOut')}
				</button>
				<button type="button" onClick={onClose} className="px-4 py-2 bg-gray-200 rounded">
					{t('common.close')}
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
	const { t } = useI18n();
	return (
		<button
			type="button"
			disabled={busy || (!item.enabled && !item.configured)}
			onClick={() => onToggle(!item.enabled)}
			className="px-4 py-2 border border-gray-400 rounded hover:bg-gray-50 disabled:opacity-50"
		>
			{item.enabled ? t('security.turnOff') : item.configured ? t('security.turnOn') : t('security.setUpFirst')}
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
	const { t } = useI18n();
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
					<button type="button" onClick={onClose} aria-label={t('common.close')} className="text-gray-500 hover:text-gray-800">
						✕
					</button>
				</div>
				{children}
			</div>
		</div>
	);
}
