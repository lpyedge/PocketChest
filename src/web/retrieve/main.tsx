import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/globals.css';
import RetrieveApp from './RetrieveApp';

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<RetrieveApp />
	</StrictMode>,
);
