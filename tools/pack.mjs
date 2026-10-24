// Usage: node tools/pack.mjs <site-dir> > payload.json
// Packs a built SvelteKit site (adapter-cloudflare, after `npm run build`) into
// the JSON the router's deploy endpoint accepts: the server code bundled into
// one module, the static files, and a version id derived from both.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";

const siteDir = resolve(process.argv[2] ?? ".");
const out = join(siteDir, ".svelte-kit/cloudflare");
if (!existsSync(join(out, "_worker.js"))) {
	console.error(`${out}/_worker.js not found: build the site with adapter-cloudflare first`);
	process.exit(1);
}
const esbuild = createRequire(join(siteDir, "package.json"))("esbuild");

// The entry re-exports SvelteKit's handler plus any Durable Object classes the
// site defines in src/objects.ts (the router runs those as facets).
const objects = join(siteDir, "src/objects.ts");
const entry =
	`export { default } from ${JSON.stringify(join(out, "_worker.js"))};\n` +
	(existsSync(objects) ? `export * from ${JSON.stringify(objects)};\n` : "");
const bundle = await esbuild.build({
	stdin: { contents: entry, resolveDir: out, loader: "js" },
	bundle: true,
	write: false,
	format: "esm",
	platform: "neutral",
	target: "es2022",
	conditions: ["workerd", "worker", "browser"],
	mainFields: ["module", "main"],
	external: ["cloudflare:*", "node:*"],
	logLevel: "warning",
});
const source = bundle.outputFiles[0].text;

const TYPES = {
	html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8",
	json: "application/json", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
	webp: "image/webp", avif: "image/avif", ico: "image/x-icon", txt: "text/plain; charset=utf-8",
	woff2: "font/woff2", woff: "font/woff", wasm: "application/wasm", webmanifest: "application/manifest+json",
};
// Server-side files the adapter writes next to the assets; never serve them.
const SERVER_ONLY = new Set(["_worker.js", "_routes.json", ".assetsignore", "_headers", "_redirects"]);
const files = (dir) =>
	readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));
const assets = files(out)
	.map((f) => relative(out, f))
	.filter((p) => !SERVER_ONLY.has(p))
	.map((path) => ({
		path,
		type: TYPES[path.split(".").pop().toLowerCase()] ?? "application/octet-stream",
		b64: readFileSync(join(out, path)).toString("base64"),
	}));

const hash = createHash("sha256").update(source);
for (const a of assets) hash.update(a.path).update(a.b64);
const version = hash.digest("hex").slice(0, 12);

process.stdout.write(JSON.stringify({ version, compatibilityDate: "2026-10-01", source, assets }));
console.error(`packed ${relative(process.cwd(), siteDir) || "."}: version ${version}, ${assets.length} assets, ${source.length} bytes of server code`);
