import { useState, useRef, DragEvent } from 'react';
import { useI18n } from '@/i18n/I18nProvider';
import { formatBytes } from '@/lib/format';
import { CloseIcon, FileIcon, UploadCloudIcon } from '@/components/Icons';

interface FileUploadProps {
	onFilesChange: (files: File[]) => void;
	files: File[];
}

export function FileUpload({ onFilesChange, files }: FileUploadProps) {
	const { t, locale } = useI18n();
	const [isDragOver, setIsDragOver] = useState(false);
	const fileInputRef = useRef<HTMLInputElement>(null);

	const handleDragEnter = (e: DragEvent) => {
		e.preventDefault();
		setIsDragOver(true);
	};

	const handleDragLeave = (e: DragEvent) => {
		e.preventDefault();
		if (e.currentTarget === e.target) {
			setIsDragOver(false);
		}
	};

	const handleDragOver = (e: DragEvent) => {
		e.preventDefault();
	};

	const handleDrop = (e: DragEvent) => {
		e.preventDefault();
		setIsDragOver(false);

		const droppedFiles = Array.from(e.dataTransfer.files);
		const newFiles = [...files, ...droppedFiles];
		onFilesChange(newFiles);
	};

	const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
		const selectedFiles = Array.from(e.target.files || []);
		const newFiles = [...files, ...selectedFiles];
		onFilesChange(newFiles);
	};

	const removeFile = (index: number) => {
		const newFiles = files.filter((_, i) => i !== index);
		onFilesChange(newFiles);
	};

	const formatFileSize = (bytes: number): string => formatBytes(bytes, locale, { zero: t('size.zero'), bytes: t('size.bytes') });

	return (
		<div className="w-full">
			<div
				className={`
          border-2 border-dashed rounded-xl p-6 text-center transition-colors cursor-pointer
          ${isDragOver ? 'border-blue-500 bg-blue-50' : 'border-gray-300 hover:border-gray-400 hover:bg-gray-50'}
        `}
				onDragEnter={handleDragEnter}
				onDragLeave={handleDragLeave}
				onDragOver={handleDragOver}
				onDrop={handleDrop}
				onClick={() => fileInputRef.current?.click()}
			>
				<div className="space-y-2">
					<UploadCloudIcon width={32} height={32} className="mx-auto text-gray-400" />
					<div>
						<p className="text-sm font-medium text-gray-900">{t('files.dropHere')}</p>
						<p className="text-xs text-gray-500">{t('files.selectMultiple')}</p>
					</div>
				</div>

				<input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileSelect} />
			</div>

			{files.length > 0 && (
				<div className="mt-4 space-y-2">
					<h3 className="text-sm font-medium text-gray-700">{t('files.selected', { count: files.length })}</h3>
					{files.map((file, index) => (
						<div key={index} className="flex items-center gap-3 p-2.5 bg-gray-50 rounded-lg">
							<FileIcon width={18} height={18} className="shrink-0 text-gray-400" />
							<div className="flex-1 min-w-0">
								<p className="text-sm font-medium truncate">{file.name}</p>
								<p className="text-xs text-gray-500">{formatFileSize(file.size)}</p>
							</div>
							<button
								onClick={(e) => {
									e.stopPropagation();
									removeFile(index);
								}}
								aria-label={t('files.remove', { name: file.name })}
								title={t('files.remove', { name: file.name })}
								className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600"
							>
								<CloseIcon width={16} height={16} />
							</button>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
