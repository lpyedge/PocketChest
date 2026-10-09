import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/globals.css';
import UploadApp from './UploadApp';

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<UploadApp />
	</StrictMode>,
);
