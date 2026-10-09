import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const webRoot = resolve(__dirname, 'src/web');

export default defineConfig({
	root: webRoot,
	publicDir: resolve(__dirname, 'public'),
	plugins: [react()],
	resolve: {
		alias: {
			'@': resolve(webRoot, 'shared'),
		},
	},
	server: {
		// `npm run dev` serves the frontend; API calls go to `npm run dev:worker`
		proxy: {
			'/api': 'http://localhost:8787',
		},
	},
	build: {
		outDir: resolve(__dirname, 'dist'),
		emptyOutDir: true,
		target: 'es2020',
		rollupOptions: {
			input: {
				home: resolve(webRoot, 'index.html'),
				upload: resolve(webRoot, 'upload/index.html'),
				retrieve: resolve(webRoot, 'retrieve/index.html'),
			},
		},
	},
});
