import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';

// The git commit as the app version, so a rebuild without changes packs the
// same deploy version (SvelteKit's default is a build timestamp).
function commit() {
	try {
		return execSync('git rev-parse --short=12 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
	} catch {
		return 'dev';
	}
}

export default defineConfig({ plugins: [sveltekit({ version: { name: commit() }, adapter: adapter() })] });
