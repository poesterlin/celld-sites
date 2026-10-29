import adapter from "@sveltejs/adapter-node";
import { sveltekit } from "@sveltejs/kit/vite";
import { execSync } from "node:child_process";
import { defineConfig } from "vite";

// SvelteKit's default app version is a build timestamp, which would change on
// every rebuild. Use the git commit instead.
const appVersion = (() => {
	try {
		return execSync("git rev-parse --short=12 HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
	} catch {
		return "dev";
	}
})();

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries.
				runes: ({ filename }) => (filename.split(/[/\\]/).includes("node_modules") ? undefined : true)
			},
			version: { name: appVersion },
			// The directives that never change are declared here; the grain origin
			// depends on runtime config and is appended by hooks.server.js.
			csp: {
				mode: "nonce",
				directives: {
					"default-src": ["self"],
					"img-src": ["self", "data:"],
					"style-src": ["self"],
					"script-src": ["self"],
					"connect-src": ["self"],
					"base-uri": ["none"],
					"frame-ancestors": ["none"]
				}
			},
			adapter: adapter()
		})
	]
});
