import adapter from '@sveltejs/adapter-cloudflare';
import { execSync } from 'node:child_process';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// SvelteKit's default app version is a build timestamp, which makes every
// rebuild a new deploy version even with no changes. Use the git commit
// instead (a constant without git), so unchanged rebuilds pack identically.
const appVersion = (() => {
	try {
		return execSync('git rev-parse --short=12 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
	} catch {
		return 'dev';
	}
})();

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			// adapter-auto only supports some environments, see https://svelte.dev/docs/kit/adapter-auto for a list.
			// If your environment is not supported, or you settled on a specific environment, switch out the adapter.
			// See https://svelte.dev/docs/kit/adapters for more information about adapters.
			version: { name: appVersion },
			adapter: adapter()
		})
	]
});
