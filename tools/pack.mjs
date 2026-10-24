// Usage: node tools/pack.mjs <site-dir> > payload.json
// Packs a built site into the JSON the router's deploy endpoint accepts: the
// server code bundled into one module, the static files, and a version id
// derived from both. Run the site's build first.
//
// <site-dir>/celld.json (optional; paths relative to the site directory):
//   worker     server entry module with `export default { fetch }`.
//              Omit, or set to null, for a static-only site.
//   assets     directory of static files, served before the worker.
//   objects    module exporting the site's Durable Object classes.
//   exclude    asset paths (relative to `assets`) never to serve, in addition
//              to the adapters' server files (_worker.js, _routes.json, ...).
//   immutable  path prefixes of content-hashed files, served with a 1-year cache.
//              Default: ["_app/immutable/", "_nuxt/", "assets/"].
//   notFound   "none" (default) or "spa": a static-only site answers unknown
//              paths with index.html (client-side routing).
// Without celld.json, the SvelteKit adapter-cloudflare layout applies:
//   { "worker": ".svelte-kit/cloudflare/_worker.js", "assets": ".svelte-kit/cloudflare",
//     "objects": "src/objects.ts" (if present) }
// The site needs esbuild in its devDependencies.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";

const siteDir = resolve(process.argv[2] ?? ".");
const fail = (msg) => {
	console.error(`pack: ${msg}`);
	process.exit(1);
};

const configFile = join(siteDir, "celld.json");
const config = existsSync(configFile)
	? JSON.parse(readFileSync(configFile, "utf8"))
	: {
			worker: ".svelte-kit/cloudflare/_worker.js",
			assets: ".svelte-kit/cloudflare",
			objects: existsSync(join(siteDir, "src/objects.ts")) ? "src/objects.ts" : undefined,
		};
const { immutable = ["_app/immutable/", "_nuxt/", "assets/"], notFound = "none", exclude = [] } = config;
if (notFound !== "none" && notFound !== "spa") fail(`notFound must be "none" or "spa"`);

const workerPath = config.worker ? join(siteDir, config.worker) : undefined;
const assetsDir = config.assets ? join(siteDir, config.assets) : undefined;
const objectsPath = config.objects ? join(siteDir, config.objects) : undefined;
if (workerPath && !existsSync(workerPath)) fail(`${relative(process.cwd(), workerPath)} not found: build the site first`);
if (assetsDir && !existsSync(assetsDir)) fail(`${relative(process.cwd(), assetsDir)} not found: build the site first`);
if (objectsPath && !existsSync(objectsPath)) fail(`objects module ${config.objects} not found`);
if (objectsPath && !workerPath) fail("objects need a worker");
if (!workerPath && !assetsDir) fail("celld.json needs a worker, assets, or both");

let source = "";
if (workerPath) {
	let esbuild;
	try {
		esbuild = createRequire(join(siteDir, "package.json"))("esbuild");
	} catch {
		fail("esbuild not found: add it to the site's devDependencies");
	}
	// The entry re-exports the framework's handler plus the site's Durable Object
	// classes (the router runs those as facets).
	const entry =
		`export { default } from ${JSON.stringify(workerPath)};\n` +
		(objectsPath ? `export * from ${JSON.stringify(objectsPath)};\n` : "");
	const bundle = await esbuild.build({
		stdin: { contents: entry, resolveDir: siteDir, loader: "js" },
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
	source = bundle.outputFiles[0].text;
}

const TYPES = {
	html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
	css: "text/css; charset=utf-8", json: "application/json", map: "application/json", txt: "text/plain; charset=utf-8",
	xml: "application/xml", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
	gif: "image/gif", webp: "image/webp", avif: "image/avif", ico: "image/x-icon", woff2: "font/woff2",
	woff: "font/woff", ttf: "font/ttf", wasm: "application/wasm", webmanifest: "application/manifest+json",
	pdf: "application/pdf", mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg",
};
// Server-side files adapters write next to the assets; never serve them.
const SERVER_ONLY = new Set(["_worker.js", "_routes.json", ".assetsignore", "_headers", "_redirects", ...exclude]);
const files = (dir) =>
	readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));
const assets = (assetsDir ? files(assetsDir) : [])
	.map((f) => relative(assetsDir, f).split("\\").join("/"))
	// _worker.js can also be a directory of server chunks (Cloudflare Pages output).
	.filter((p) => !SERVER_ONLY.has(p) && !p.startsWith("_worker.js/"))
	.map((path) => ({
		path,
		type: TYPES[path.split(".").pop().toLowerCase()] ?? "application/octet-stream",
		b64: readFileSync(join(assetsDir, path)).toString("base64"),
	}));

const hash = createHash("sha256").update(source).update(JSON.stringify({ immutable, notFound }));
for (const a of assets) hash.update(a.path).update(a.b64);
const version = hash.digest("hex").slice(0, 12);

process.stdout.write(JSON.stringify({ version, compatibilityDate: "2026-10-01", source, assets, immutable, notFound }));
console.error(
	`packed ${relative(process.cwd(), siteDir) || "."}: version ${version}, ${assets.length} assets, ` +
		(source ? `${source.length} bytes of server code` : "static only"),
);
