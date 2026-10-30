// Builds the publishable CLI into dist/: hamstr.mjs (the CLI, the shared app
// format and tar-stream in one file) and pack.mjs (tools/pack.mjs, run as a
// separate process, which finds esbuild in this package's dependencies).
//   npm run build        then   npm pack   →  hamstr-cli-<version>.tgz
import { build } from "esbuild";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const here = import.meta.dirname;
const dist = join(here, "dist");
const { version } = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
const source = readFileSync(join(here, "hamstr.mjs"), "utf8");
if (!source.includes(`const VERSION = "${version}";`)) throw new Error(`hamstr.mjs VERSION does not match package.json (${version})`);

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist);
await build({
	entryPoints: [join(here, "hamstr.mjs")],
	outfile: join(dist, "hamstr.mjs"),
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node20",
	banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
	legalComments: "inline",
	logLevel: "warning",
});
chmodSync(join(dist, "hamstr.mjs"), 0o755);
copyFileSync(join(here, "..", "..", "tools", "pack.mjs"), join(dist, "pack.mjs"));
console.log(`built dist/ (hamstr ${version})`);
