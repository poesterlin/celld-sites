import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

// A single-page app: ../server.mjs serves build/ and answers every page path
// with build/index.html. The CSP is set by the server, which also allows the
// fallback page's inline bootstrap script by its hash.
export default defineConfig({
	server: {
		fs: { allow: ["../.."] },
		// `npm run dev` talks to a store on :3000 (node ../server.mjs).
		proxy: { "/api": "http://127.0.0.1:3000" },
	},
	plugins: [
		sveltekit({
			compilerOptions: {
				runes: ({ filename }) => (filename.split(/[/\\]/).includes("node_modules") ? undefined : true),
			},
			adapter: adapter({ fallback: "index.html" }),
		}),
	],
});
