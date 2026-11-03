import { ValidityDays } from '@/lib/types';
import { MessageKey, useI18n } from '@/i18n/I18nProvider';

interface ExpirySelectorProps {
	value: ValidityDays;
	onChange: (days: ValidityDays) => void;
}

const expirySteps: { value: ValidityDays; label: MessageKey; description: MessageKey }[] = [
	{ value: 1, label: 'expiry.1d', description: 'expiry.1d.desc' },
	{ value: 3, label: 'expiry.3d', description: 'expiry.3d.desc' },
	{ value: 7, label: 'expiry.1w', description: 'expiry.1w.desc' },
	{ value: 14, label: 'expiry.2w', description: 'expiry.2w.desc' },
	{ value: 30, label: 'expiry.1m', description: 'expiry.1m.desc' },
	{ value: 90, label: 'expiry.3m', description: 'expiry.3m.desc' },
	{ value: -1, label: 'expiry.permanent', description: 'expiry.permanent.desc' },
];

// One sliding control instead of a wall of buttons: drag or tap a stop,
// the current choice reads next to the heading, and the keyboard works too.
export function ExpirySelector({ value, onChange }: ExpirySelectorProps) {
	const { t } = useI18n();
	const index = Math.max(
		0,
		expirySteps.findIndex((step) => step.value === value),
	);
	const filled = (index / (expirySteps.length - 1)) * 100;
	return (
		<div className="space-y-1.5">
			<div className="flex items-baseline justify-between gap-3">
				<span id="expiry-label" className="text-sm font-medium text-gray-900">
					{t('expiry.label')}
				</span>
				<span aria-hidden="true" className="text-sm font-semibold text-blue-700">
					{t(expirySteps[index].label)}
				</span>
			</div>
			{/* Fully drawn slider: the native input stays invisible over the whole area (pointer, keyboard,
				accessible name) while track, fill, knob and stop dots below share one coordinate space,
				so every stop lines up in every browser. */}
			<div className="relative h-6">
				<div aria-hidden="true" className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-gray-200" />
				<div
					aria-hidden="true"
					className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-blue-600"
					style={{ left: 0, width: `${filled}%` }}
				/>
				{expirySteps.map((step, stepIndex) => (
					<span
						key={step.value}
						aria-hidden="true"
						className={`absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ${
							stepIndex === index ? 'bg-blue-600' : stepIndex < index ? 'bg-blue-300' : 'bg-gray-400'
						}`}
						style={{ left: `${(stepIndex / (expirySteps.length - 1)) * 100}%` }}
					/>
				))}
				<span
					aria-hidden="true"
					className="pointer-events-none absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-gray-300 bg-white shadow-md peer-focus-visible:outline-2 peer-focus-visible:outline-blue-500"
					style={{ left: `${filled}%` }}
				/>
				<input
					type="range"
					min={0}
					max={expirySteps.length - 1}
					step={1}
					value={index}
					onChange={(event) => onChange(expirySteps[Number(event.target.value)].value)}
					aria-labelledby="expiry-label"
					aria-valuetext={t(expirySteps[index].label)}
					className="expiry-range peer absolute inset-0"
				/>
			</div>
			<div className="flex justify-between" role="group" aria-label={t('expiry.label')}>
				{expirySteps.map((step, stepIndex) => (
					<button
						key={step.value}
						type="button"
						onClick={() => onChange(step.value)}
						aria-pressed={stepIndex === index}
						title={t(step.description)}
						className={`whitespace-nowrap text-[9px] leading-tight tracking-tight sm:text-[11px] sm:tracking-normal ${
							stepIndex === index ? 'font-semibold text-blue-700' : 'text-gray-500 hover:text-gray-800'
						}`}
					>
						{t(step.label)}
					</button>
				))}
			</div>
		</div>
	);
}
