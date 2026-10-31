// The SvelteKit settings every Hamstr-style app shares: runes everywhere, the
// git commit as the app version, and a strict nonce CSP. Each app adds its own
// adapter (and any CSP sources only known at runtime, in its hooks).
//
//   sveltekit({ ...kitOptions(), adapter: adapter() })
import { execSync } from "node:child_process";

// SvelteKit's default app version is a build timestamp, which would change on
// every rebuild. Use the git commit instead.
function appVersion(): string {
	try {
		return execSync("git rev-parse --short=12 HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
	} catch {
		return "dev";
	}
}

export function kitOptions() {
	return {
		compilerOptions: {
			// Force runes mode for the project, except for libraries.
			runes: ({ filename }: { filename: string }) => (filename.split(/[/\\]/).includes("node_modules") ? undefined : true),
		},
		version: { name: appVersion() },
		csp: {
			mode: "nonce" as const,
			directives: {
				"default-src": ["self" as const],
				"img-src": ["self" as const, "data:" as const],
				"style-src": ["self" as const],
				"script-src": ["self" as const],
				"connect-src": ["self" as const],
				"base-uri": ["none" as const],
				"frame-ancestors": ["none" as const],
			},
		},
	};
}
