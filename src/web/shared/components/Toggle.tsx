interface ToggleProps {
	checked: boolean;
	onChange: (checked: boolean) => void;
	label: string;
	disabled?: boolean;
	// Why the switch cannot be used right now; shown as its tooltip
	title?: string;
}

// An iOS-style switch. Its label is the accessible name.
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
			className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 disabled:cursor-not-allowed disabled:opacity-50 ${
				checked ? 'bg-[#34c759]' : 'bg-gray-300 hover:bg-gray-400/70'
			}`}
		>
			<span
				aria-hidden="true"
				className={`inline-block h-6 w-6 rounded-full bg-white shadow-md transition-transform duration-200 ${
					checked ? 'translate-x-[22px]' : 'translate-x-[2px]'
				}`}
			/>
		</button>
	);
}
