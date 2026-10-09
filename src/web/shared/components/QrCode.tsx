import { useMemo } from 'react';
import { qrMatrix, QUIET_ZONE } from '@/lib/qr';

interface QrCodeProps {
	value: string;
	label: string;
}

// Drawn as one SVG path from the module matrix: nothing is sent anywhere, and no markup is injected
export function QrCode({ value, label }: QrCodeProps) {
	const { size, path } = useMemo(() => {
		const modules = qrMatrix(value);
		const parts: string[] = [];
		modules.forEach((row, r) =>
			row.forEach((dark, c) => {
				if (dark) parts.push(`M${c + QUIET_ZONE} ${r + QUIET_ZONE}h1v1h-1z`);
			}),
		);
		return { size: modules.length + QUIET_ZONE * 2, path: parts.join('') };
	}, [value]);

	return (
		<svg
			role="img"
			aria-label={label}
			viewBox={`0 0 ${size} ${size}`}
			shapeRendering="crispEdges"
			className="w-48 h-48 bg-white border border-gray-200 rounded"
		>
			<path d={path} fill="#000" />
		</svg>
	);
}
