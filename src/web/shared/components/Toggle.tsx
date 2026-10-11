interface ToggleProps {
	checked: boolean;
	onChange: (checked: boolean) => void;
	label: string;
	disabled?: boolean;
	// Why the switch cannot be used right now; shown as its tooltip
	title?: string;
}

// A switch. Its label is the accessible name.
export function Toggle({ checked, onChange, label, disabled = false, title }: ToggleProps) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			title={title}
			disabled={disabled}
			onClick={() => onChange(!checked)}
			className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-50 ${
				checked ? 'bg-blue-600' : 'bg-gray-300'
			}`}
		>
			<span
				aria-hidden="true"
				className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5.5' : 'translate-x-0.5'}`}
			/>
		</button>
	);
}
