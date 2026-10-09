// Vite imports Markdown files as text with the ?raw suffix
declare module '*.md?raw' {
	const content: string;
	export default content;
}
