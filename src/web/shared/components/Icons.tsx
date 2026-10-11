import type { ReactNode, SVGProps } from 'react';

// Small stroke icons (24px grid). They are decorative: the button or link around one carries the accessible name.
function Icon({ children, ...props }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
	return (
		<svg
			viewBox="0 0 24 24"
			width="20"
			height="20"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			focusable="false"
			{...props}
		>
			{children}
		</svg>
	);
}

type IconProps = SVGProps<SVGSVGElement>;

export const HomeIcon = (p: IconProps) => (
	<Icon {...p}>
		<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
		<path d="M9 22V12h6v10" />
	</Icon>
);

export const UserIcon = (p: IconProps) => (
	<Icon {...p}>
		<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
		<circle cx="12" cy="7" r="4" />
	</Icon>
);

export const KeyIcon = (p: IconProps) => (
	<Icon {...p}>
		<circle cx="7.5" cy="15.5" r="5.5" />
		<path d="m21 2-9.6 9.6" />
		<path d="m15.5 7.5 3 3L22 7l-3-3" />
	</Icon>
);

export const CopyIcon = (p: IconProps) => (
	<Icon {...p}>
		<rect width="14" height="14" x="8" y="8" rx="2" />
		<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
	</Icon>
);

export const CheckIcon = (p: IconProps) => (
	<Icon {...p}>
		<path d="M20 6 9 17l-5-5" />
	</Icon>
);

export const CheckCircleIcon = (p: IconProps) => (
	<Icon {...p}>
		<circle cx="12" cy="12" r="10" />
		<path d="m8 12 3 3 5-6" />
	</Icon>
);

export const TrashIcon = (p: IconProps) => (
	<Icon {...p}>
		<path d="M3 6h18" />
		<path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
		<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
	</Icon>
);

export const CloseIcon = (p: IconProps) => (
	<Icon {...p}>
		<path d="M18 6 6 18" />
		<path d="m6 6 12 12" />
	</Icon>
);

export const ExternalLinkIcon = (p: IconProps) => (
	<Icon {...p}>
		<path d="M15 3h6v6" />
		<path d="M10 14 21 3" />
		<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
	</Icon>
);

export const LogOutIcon = (p: IconProps) => (
	<Icon {...p}>
		<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
		<path d="m16 17 5-5-5-5" />
		<path d="M21 12H9" />
	</Icon>
);

export const ShieldIcon = (p: IconProps) => (
	<Icon {...p}>
		<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
	</Icon>
);

export const LockIcon = (p: IconProps) => (
	<Icon {...p}>
		<rect width="18" height="11" x="3" y="11" rx="2" />
		<path d="M7 11V7a5 5 0 0 1 10 0v4" />
	</Icon>
);

export const PhoneIcon = (p: IconProps) => (
	<Icon {...p}>
		<rect width="14" height="20" x="5" y="2" rx="2" />
		<path d="M12 18h.01" />
	</Icon>
);

export const FingerprintIcon = (p: IconProps) => (
	<Icon {...p}>
		<path d="M12 11a3 3 0 0 0-3 3c0 2 .5 4 1.5 6" />
		<path d="M15 14c0 3-.5 5-1.5 7" />
		<path d="M6 12a6 6 0 0 1 12 0c0 1.5-.1 3-.4 4.5" />
		<path d="M3 11a9 9 0 0 1 18 0" />
		<path d="M6.5 17c.3-1 .5-2 .5-3" />
	</Icon>
);

export const FileIcon = (p: IconProps) => (
	<Icon {...p}>
		<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
		<path d="M14 2v6h6" />
	</Icon>
);

export const UploadCloudIcon = (p: IconProps) => (
	<Icon {...p}>
		<path d="M4 14.9A7 7 0 1 1 15.7 8h1.8a4.5 4.5 0 0 1 2.5 8.2" />
		<path d="M12 12v9" />
		<path d="m16 16-4-4-4 4" />
	</Icon>
);

export const LinkIcon = (p: IconProps) => (
	<Icon {...p}>
		<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
		<path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
	</Icon>
);

export const RefreshIcon = (p: IconProps) => (
	<Icon {...p}>
		<path d="M21 12a9 9 0 0 0-15.5-6.2L3 8" />
		<path d="M3 3v5h5" />
		<path d="M3 12a9 9 0 0 0 15.5 6.2L21 16" />
		<path d="M16 16h5v5" />
	</Icon>
);

export const ListIcon = (p: IconProps) => (
	<Icon {...p}>
		<path d="M8 6h13" />
		<path d="M8 12h13" />
		<path d="M8 18h13" />
		<path d="M3 6h.01" />
		<path d="M3 12h.01" />
		<path d="M3 18h.01" />
	</Icon>
);
