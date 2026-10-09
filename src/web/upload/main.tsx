import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/globals.css';
import { I18nProvider } from '@/i18n/I18nProvider';
import UploadApp from './UploadApp';

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<I18nProvider>
			<UploadApp />
		</I18nProvider>
	</StrictMode>,
);
