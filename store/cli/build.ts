// Builds the publishable CLI into dist/: hamstr.mjs (the CLI, the shared app
// format and tar-stream in one file) and pack.mjs (tools/pack.ts, bundled, run
// as a separate process, which finds esbuild in this package's dependencies).
//   npm run build        then   npm pack   →  hamstr-cli-<version>.tgz
//
// The CLI targets node20, which cannot run TypeScript, so both entries are
// compiled here. pack.mjs keeps esbuild external: it is resolved at runtime.
import { build, type BuildOptions } from "esbuild";
import { chmodSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dirname;
const dist = join(here, "dist");
const { version } = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
const source = readFileSync(join(here, "hamstr.ts"), "utf8");
if (!source.includes(`const VERSION = "${version}";`)) throw new Error(`hamstr.ts VERSION does not match package.json (${version})`);

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);
const common: BuildOptions = {
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node20",
	legalComments: "inline",
	logLevel: "warning",
};
await build({
	...common,
	entryPoints: [join(here, "hamstr.ts")],
	outfile: join(dist, "hamstr.mjs"),
	banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});
await build({
	...common,
	entryPoints: [join(here, "..", "..", "tools", "pack.ts")],
	outfile: join(dist, "pack.mjs"),
	external: ["esbuild"],
});
chmodSync(join(dist, "hamstr.mjs"), 0o755);
console.log(`built dist/ (hamstr ${version})`);
