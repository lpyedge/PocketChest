import type { ReactNode } from 'react';

interface Common {
	label: string;
	children: ReactNode;
	className?: string;
	// Where the tooltip sits under the control; icons at the right edge of the page open it leftwards
	align?: 'center' | 'right';
}

type IconButtonProps = Common &
	({ href: string; onClick?: never; disabled?: never } | { href?: never; onClick: () => void; disabled?: boolean });

// An icon-only control. The label is its accessible name and also its tooltip (shown on hover and on keyboard focus).
export function IconButton({ label, children, className = '', align = 'center', href, onClick, disabled }: IconButtonProps) {
	const classes = `inline-flex h-9 w-9 items-center justify-center rounded-lg text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900 focus-visible:outline-2 focus-visible:outline-blue-500 disabled:opacity-40 disabled:hover:bg-transparent ${className}`;
	return (
		<span className="group relative inline-flex">
			{href !== undefined ? (
				<a href={href} aria-label={label} className={classes}>
					{children}
				</a>
			) : (
				<button type="button" onClick={onClick} disabled={disabled} aria-label={label} className={classes}>
					{children}
				</button>
			)}
			<span
				aria-hidden="true"
				className={`pointer-events-none absolute top-full z-50 mt-1.5 whitespace-nowrap rounded-md bg-gray-900 px-2 py-1 text-xs text-white opacity-0 shadow transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 ${
					align === 'right' ? 'right-0' : 'left-1/2 -translate-x-1/2'
				}`}
			>
				{label}
			</span>
		</span>
	);
}
