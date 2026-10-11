import { useEffect, useState, type ReactNode } from 'react';
import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
import { authApi, AuthRequestError, Rotation, SecurityStatus } from '@/lib/auth-api';
import { describeAuthError } from '@/components/AuthMethodPicker';
import { useI18n } from '@/i18n/I18nProvider';
import { QrCode } from '@/components/QrCode';
import { totpSecretFrom } from '@/lib/qr';
import { Dialog } from '@/components/Dialog';
import { IconButton } from '@/components/IconButton';
import { Toggle } from '@/components/Toggle';
import { CheckIcon, CopyIcon, FingerprintIcon, LockIcon, LogOutIcon, PhoneIcon, ShieldIcon, TrashIcon } from '@/components/Icons';

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
	// A proof of holding a method that is off, to switch it on; not a re-entry
	activate?: boolean;
}

function statusLabel(
	item: { configured: boolean; enabled: boolean },
	t: (key: 'security.notSetUp' | 'security.on' | 'security.offSetUp') => string,
): string {
	if (!item.configured) return t('security.notSetUp');
	return item.enabled ? t('security.on') : t('security.offSetUp');
}

// The same seed as the QR code, for typing by hand. It only lives in this component's state: never stored.
function ManualKey({ otpauthUri }: { otpauthUri: string }) {
	const { t } = useI18n();
	const [copied, setCopied] = useState(false);
	const key = totpSecretFrom(otpauthUri);
	if (!key) return null;
	return (
		<div className="space-y-1">
			<p className="text-sm text-gray-700">{t('security.orTypeKey')}</p>
			<div className="flex items-center gap-2">
				<code data-testid="totp-secret" className="block flex-1 rounded-lg bg-gray-100 p-2 text-sm tracking-wider break-all">
					{key.grouped}
				</code>
				<IconButton
					label={copied ? t('security.keyCopied') : t('security.copyKey')}
					align="right"
					onClick={() => {
						navigator.clipboard
							.writeText(key.secret)
							.then(() => setCopied(true))
							.catch(() => setCopied(false));
					}}
				>
					{copied ? <CheckIcon className="text-green-600" /> : <CopyIcon />}
				</IconButton>
			</div>
		</div>
	);
}

export function SecuritySettingsModal({ csrfToken, onRotated, onClose, onSignedOut }: SecuritySettingsModalProps) {
	const { t, locale } = useI18n();
	const [status, setStatus] = useState<SecurityStatus | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
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
	const attempt = async (run: (token: string) => Promise<Rotation | void>, required: Method | null = null, success?: () => string) => {
		setBusy(true);
		setMessage(null);
		setNotice(null);
		try {
			const result = await run(csrf);
			if (result && 'csrfToken' in result) {
				setCsrf(result.csrfToken);
				onRotated(result.csrfToken);
			}
			await refresh();
			if (success) setNotice(success());
		} catch (error) {
			if (error instanceof AuthRequestError && error.code === 'ACTIVATION_PROOF_REQUIRED' && required) {
				setPending({ run: () => attempt(run, required, success), required, activate: true });
			} else if (error instanceof AuthRequestError && (error.code === 'REAUTH_REQUIRED' || error.code === 'REAUTH_METHOD_REQUIRED')) {
				// Any method that is on can re-enter; the method being switched on (if any) is proved separately afterwards
				setPending({ run: () => attempt(run, required, success), required: null });
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
	const reenter = async (method: Method, action: () => Promise<void>, activate = false) => {
		setBusy(true);
		setMessage(null);
		try {
			if (method === 'password') {
				await (activate ? authApi.activatePassword(csrf, reauthPassword) : authApi.reauthPassword(csrf, reauthPassword));
				setReauthPassword('');
			} else if (method === 'totp') {
				await (activate ? authApi.activateTotp(csrf, reauthCode) : authApi.reauthTotp(csrf, reauthCode));
				setReauthCode('');
			} else {
				const options = await (activate ? authApi.activatePasskeyOptions(csrf) : authApi.reauthPasskeyOptions(csrf));
				const response = await startAuthentication({ optionsJSON: options });
				await (activate
					? authApi.activatePasskeyVerify(csrf, options.challenge, response)
					: authApi.reauthPasskeyVerify(csrf, options.challenge, response));
			}
			setPending(null);
			await action();
		} catch (error) {
			setMessage(describeAuthError(error, t));
		} finally {
			setBusy(false);
		}
	};

	// A re-entry can only use a method that is switched on; a proof for switching one on again uses that method itself
	const offeredMethods = (required: Method | null, activate = false): Method[] => {
		if (!status) return [];
		const all: Method[] = ['password', 'totp', 'passkey'];
		return all.filter((method) => {
			const item = status.methods[method];
			return (required === null || required === method) && item.configured && (activate || item.enabled);
		});
	};

	const toggle = (method: Method, enabled: boolean) =>
		attempt((token) => authApi.setMethod(token, method, enabled), enabled ? method : null);

	const registerPasskey = () => {
		// Whether this is the first passkey (and so switches the method on) is known from what is on screen now
		const first = !status?.methods.passkey.configured;
		return attempt(
			async (token) => {
				const options = await authApi.passkeyRegisterOptions(token);
				const response = await startRegistration({ optionsJSON: options });
				const registered = await authApi.passkeyRegisterVerify(token, options.challenge, response, t('security.thisDevice'));
				// The first passkey replaces the session: carry on with the new token the server sent with it
				if (registered.csrfToken && registered.security) return { csrfToken: registered.csrfToken, security: registered.security };
			},
			null,
			() => t(first ? 'security.passkeyDone' : 'security.passkeyAdded'),
		);
	};

	const removePasskey = (id: string, label: string) => {
		if (!window.confirm(t('security.removeConfirm', { label }))) return;
		attempt((token) => authApi.passkeyRemove(token, id));
	};

	const submitTotpCode = () => {
		const replacing = Boolean(status?.methods.totp.configured);
		return attempt(
			async (token) => {
				if (!totpSetup) return;
				try {
					const rotated = await authApi.totpConfirm(token, totpSetup.challenge, totpCode);
					setTotpSetup(null);
					setTotpCode('');
					return rotated;
				} catch (error) {
					if (error instanceof AuthRequestError && error.code === 'CHALLENGE_INVALID') {
						// Too many wrong codes, or the setup timed out: the QR on screen is dead, so it is removed
						// instead of being left to mislead; the message tells the owner to start again
						setTotpSetup(null);
					}
					// A wrong code keeps the same QR on screen: the key is still good, only the code has to be typed again
					setTotpCode('');
					throw error;
				}
			},
			null,
			() => t(replacing ? 'security.totpReplaced' : 'security.totpDone'),
		);
	};

	// Why a method's switch cannot be used: it was never set up, or it is the only way left to sign in
	const lockReason = (method: Method): string | null => {
		if (!status) return null;
		const item = status.methods[method];
		const enabledCount = Object.values(status.methods).filter((entry) => entry.enabled).length;
		if (item.enabled && enabledCount <= 1) return t('code.LAST_AUTH_METHOD');
		return null;
	};

	// A method that is not set up has nothing to switch: the one call to action is its "set up" button
	const methodToggle = (method: Method, label: string) =>
		!status || (!status.methods[method].enabled && !status.methods[method].configured) ? null : (
			<Toggle
				checked={status?.methods[method].enabled ?? false}
				onChange={(enabled) => toggle(method, enabled)}
				label={t('security.switchLabel', { name: label })}
				disabled={busy || lockReason(method) !== null}
				title={lockReason(method) ?? undefined}
			/>
		);

	if (!status) {
		return (
			<Dialog title={t('security.title')} icon={<ShieldIcon width={18} height={18} />} onClose={onClose}>
				<p className="text-gray-600">{message ?? t('common.loading')}</p>
			</Dialog>
		);
	}

	return (
		<Dialog title={t('security.title')} icon={<ShieldIcon width={18} height={18} />} onClose={onClose}>
			{message && (
				<p role="alert" className="mb-4 text-sm text-red-700">
					{message}
				</p>
			)}
			{notice && !message && (
				<p role="status" className="mb-4 text-sm text-green-700">
					{notice}
				</p>
			)}
			<p className="mb-4 text-xs text-gray-600">{t('security.independentNote')}</p>

			{pending && (
				<section className="mb-4 p-4 border border-amber-300 bg-amber-50 rounded-xl space-y-3">
					<p className="text-sm text-gray-800">
						{pending.required ? t('security.confirmTitleWith', { method: t(`method.${pending.required}`) }) : t('security.confirmTitle')}
					</p>
					{offeredMethods(pending.required, pending.activate).map((method) => {
						if (method === 'password') {
							return (
								<form
									key={method}
									className="flex gap-2"
									onSubmit={(event) => {
										event.preventDefault();
										reenter('password', pending.run, pending.activate);
									}}
								>
									<input
										type="password"
										aria-label={t('auth.password')}
										value={reauthPassword}
										onChange={(event) => setReauthPassword(event.target.value)}
										className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm"
									/>
									<button
										type="submit"
										disabled={busy}
										className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
									>
										{t('security.confirmPassword')}
									</button>
								</form>
							);
						}
						if (method === 'totp') {
							return (
								<div key={method} className="space-y-1">
									<form
										className="flex gap-2"
										onSubmit={(event) => {
											event.preventDefault();
											reenter('totp', pending.run, pending.activate);
										}}
									>
										<input
											inputMode="numeric"
											aria-label={t('auth.code')}
											maxLength={6}
											value={reauthCode}
											onChange={(event) => setReauthCode(event.target.value)}
											className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm"
										/>
										<button
											type="submit"
											disabled={busy}
											className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
										>
											{t('security.confirmAuthenticator')}
										</button>
									</form>
									<p className="text-xs text-gray-600">{t('security.totpWait')}</p>
								</div>
							);
						}
						return (
							<button
								key={method}
								type="button"
								disabled={busy}
								onClick={() => reenter('passkey', pending.run, pending.activate)}
								className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-800 hover:bg-gray-50 disabled:opacity-50"
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

			<Section
				title={t('auth.password')}
				icon={<LockIcon />}
				label={statusLabel(status.methods.password, t)}
				control={methodToggle('password', t('auth.password'))}
				hint={lockReason('password')}
			>
				<form
					className="space-y-2"
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
						className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
					/>
					<input
						type="password"
						aria-label={t('security.confirmNewPassword')}
						placeholder={t('security.confirmNewPassword')}
						autoComplete="new-password"
						value={confirmPassword}
						onChange={(event) => setConfirmPassword(event.target.value)}
						className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
					/>
					<button
						type="submit"
						disabled={busy}
						className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-800 hover:bg-gray-50 disabled:opacity-50"
					>
						{t('security.changePassword')}
					</button>
					<p className="text-xs text-gray-500">{t('security.changeNote')}</p>
				</form>
			</Section>

			<Section
				title={t('security.authenticatorSection')}
				icon={<PhoneIcon />}
				label={statusLabel(status.methods.totp, t)}
				control={methodToggle('totp', t('security.authenticatorSection'))}
				hint={lockReason('totp')}
			>
				<p className="mb-3 text-xs text-gray-600">{t('security.totpNote')}</p>
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
						className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-800 hover:bg-gray-50 disabled:opacity-50"
					>
						{status.methods.totp.configured ? t('security.replaceAuthenticator') : t('security.setUpAuthenticator')}
					</button>
				) : (
					<div className="space-y-2">
						<p className="text-sm text-gray-700">{t('security.scanQr')}</p>
						<QrCode value={totpSetup.otpauthUri} label={t('security.qrLabel')} />
						<ManualKey otpauthUri={totpSetup.otpauthUri} />
						<p className="text-sm text-gray-700">{t('security.addKey')}</p>
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
								className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm"
							/>
							<button
								type="submit"
								disabled={busy}
								className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
							>
								{t('security.confirmCode')}
							</button>
						</form>
						<button type="button" onClick={() => setTotpSetup(null)} className="text-sm text-gray-600 underline">
							{t('security.cancelSetup')}
						</button>
					</div>
				)}
			</Section>

			<Section
				title={t('security.passkeysSection')}
				icon={<FingerprintIcon />}
				label={statusLabel(status.methods.passkey, t)}
				control={methodToggle('passkey', t('security.passkeysSection'))}
				hint={lockReason('passkey')}
			>
				<ul className="mb-3 space-y-2 empty:hidden">
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
					className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-800 hover:bg-gray-50 disabled:opacity-50"
				>
					{t('security.addPasskey')}
				</button>
				<p className="mt-2 text-xs text-gray-500">{t('security.passkeyNote')}</p>
			</Section>

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
				className="flex w-full items-center justify-center gap-2 rounded-lg border border-gray-300 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
			>
				<LogOutIcon width={16} height={16} />
				{t('upload.signOut')}
			</button>
		</Dialog>
	);
}

function Section({
	title,
	icon,
	label,
	control,
	hint,
	children,
}: {
	title: string;
	icon: ReactNode;
	label: string;
	control: ReactNode;
	hint: string | null;
	children: ReactNode;
}) {
	return (
		<section className="mb-4 rounded-xl border border-gray-200 p-4">
			<div className="flex items-center gap-3">
				<span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gray-100 text-gray-600">{icon}</span>
				<div className="min-w-0 flex-1">
					<h3 className="text-sm font-semibold text-gray-900">{title}</h3>
					<p className="text-xs text-gray-500">{label}</p>
				</div>
				{control}
			</div>
			{hint && <p className="mt-2 text-xs text-gray-500">{hint}</p>}
			<div className="mt-2 border-t border-gray-100 pt-3">{children}</div>
		</section>
	);
}
