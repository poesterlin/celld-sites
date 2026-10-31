import adapter from "@sveltejs/adapter-node";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import { kitOptions } from "../packages/ui/kit.ts";

export default defineConfig({
	// The design system lives in packages/ui.
	server: { fs: { allow: [".."] } },
	plugins: [sveltekit({ ...kitOptions(), adapter: adapter() })],
});
