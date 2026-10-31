import adapter from "@sveltejs/adapter-node";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import { kitOptions } from "../packages/ui/kit.ts";

export default defineConfig({
	// The design system (packages/ui) and the app format live outside this app.
	server: { fs: { allow: [".."] } },
	// The CSP directives that never change come from kitOptions(); the grain
	// origin depends on runtime config and is appended by hooks.server.ts.
	plugins: [sveltekit({ ...kitOptions(), adapter: adapter() })]
});
