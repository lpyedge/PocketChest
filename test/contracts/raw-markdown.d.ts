// Vite imports Markdown files as text with the ?raw suffix
declare module '*.md?raw' {
	const content: string;
	export default content;
}

// Other text files read the same way, for the checks on deployment configuration
declare module '*?raw' {
	const content: string;
	export default content;
}
