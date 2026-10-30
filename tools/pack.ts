// Usage: node tools/pack.ts <site-dir> <out-dir>
// Packs a built site into a deploy bundle in <out-dir>: the server code bundled
// into one module, the static files, and a version id derived from both. Run
// the site's build first. node/push.sh uploads a bundle (tools/deploy.sh does
// both). Bundle layout:
//   version     the version id
//   code.json   { compatibilityDate, source, files: { path: [sha256, type] }, immutable, mutable, notFound }
//   blobs/<sha256>  each distinct file's bytes, named by their hash (push.sh
//               uploads only the ones the router doesn't have yet)
// Symlinks in the static directory and files over 20 MiB are refused.
//
// <site-dir>/celld.json (optional; paths relative to the site directory):
//   worker     server entry module with `export default { fetch }`.
//              Omit, or set to null, for a static-only site.
//   assets     directory of static files, served before the worker.
//   objects    module exporting the site's Durable Object classes.
//   exclude    asset paths (relative to `assets`) never to serve, in addition
//              to the adapters' server files (_worker.js, _routes.json, ...).
//   immutable  path prefixes of content-hashed files, served with a 1-year cache.
//              Default: whichever of _app/immutable/ (SvelteKit) and _nuxt/ (Nuxt)
//              exist, plus assets/ (Vite) if every file in it has a hash in its name.
//   mutable    exact paths under those prefixes that do change between builds
//              (never cached for long). _nuxt/builds/latest.json is always added.
//   compatibilityDate  workerd compatibility date, YYYY-MM-DD (default 2026-10-01).
//   check      path a deploy requests before activating, and probes after it
//              (default "/"); false skips both. See node/push.sh.
//   notFound   "none" (default) or "spa": a static-only site answers unknown
//              paths with index.html (client-side routing).
//   minify     true: minify the bundled server code (default false). For big
//              builds (EmDash/Astro: 12 MB -> 8 MB) under the 16 MiB code limit.
// Without celld.json, the SvelteKit adapter-cloudflare layout applies:
//   { "worker": ".svelte-kit/cloudflare/_worker.js", "assets": ".svelte-kit/cloudflare",
//     "objects": "src/objects.ts" (if present) }
// esbuild comes from the site's devDependencies, else from tools/ (npm ci --prefix tools).
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { join, relative, resolve } from "node:path";

const siteDir = resolve(process.argv[2] ?? ".");
const outDir = process.argv[3] ? resolve(process.argv[3]) : undefined;
const MAX_FILE_BYTES = 20 * 1024 * 1024; // the router refuses larger files
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
const { notFound = "none", exclude = [], compatibilityDate = "2026-10-01", check = "/", minify = false } = config;
if (typeof minify !== "boolean") fail("minify must be true or false");
if (check !== false && (typeof check !== "string" || !check.startsWith("/"))) fail(`check must be a path starting with "/", or false`);
if (notFound !== "none" && notFound !== "spa") fail(`notFound must be "none" or "spa"`);
// celld 0.6.3 accepts any string here (even a non-date), so check it ourselves.
if (typeof compatibilityDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(compatibilityDate)) fail("compatibilityDate must be YYYY-MM-DD");
// Files that sit under an immutable prefix but change with every build.
const ALWAYS_MUTABLE = ["_nuxt/builds/latest.json"];
const mutable = [...new Set([...(config.mutable ?? []), ...ALWAYS_MUTABLE])];

const workerPath = config.worker ? join(siteDir, config.worker) : undefined;
const assetsDir = config.assets ? join(siteDir, config.assets) : undefined;
const objectsPath = config.objects ? join(siteDir, config.objects) : undefined;
if (workerPath && !existsSync(workerPath)) fail(`${relative(process.cwd(), workerPath)} not found: build the site first`);
if (assetsDir && !existsSync(assetsDir)) fail(`${relative(process.cwd(), assetsDir)} not found: build the site first`);
if (objectsPath && !existsSync(objectsPath)) fail(`objects module ${config.objects} not found`);
if (objectsPath && !workerPath) fail("objects need a worker");
if (!workerPath && !assetsDir) fail("celld.json needs a worker, assets, or both");

// celld 0.6.3 exposes node:timers, but its setImmediate/clearImmediate throw
// "not implemented" while the global functions work. Builds that turn global
// setImmediate into an import (Nitro/h3, so every Nuxt site) then fail on every
// request. Site imports of node:timers get this shim built on the globals.
// (It must not import node:timers itself; node:timers/promises works.)
const TIMERS_SHIM = `
import * as timersPromises from "node:timers/promises";
const g = globalThis;
export const setTimeout = (...a) => g.setTimeout(...a);
export const clearTimeout = (...a) => g.clearTimeout(...a);
export const setInterval = (...a) => g.setInterval(...a);
export const clearInterval = (...a) => g.clearInterval(...a);
export const setImmediate = (...a) => g.setImmediate(...a);
export const clearImmediate = (...a) => g.clearImmediate(...a);
export const promises = timersPromises;
export default { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate, promises };
`;
const BARE_BUILTIN = new RegExp(`^(${builtinModules.filter((m) => !m.startsWith("_") && m !== "timers").map((m) => m.replace(/[/]/g, "\\/")).join("|")})$`);
const celldShims = {
	name: "celld-shims",
	setup(build) {
		build.onResolve({ filter: /^(node:)?timers$/ }, () => ({ path: "timers", namespace: "celld-shim" }));
		build.onLoad({ filter: /.*/, namespace: "celld-shim" }, () => ({ contents: TIMERS_SHIM, loader: "js", resolveDir: siteDir }));
		// Bundled CommonJS dependencies (e.g. in Astro builds) import Node built-ins
		// by their bare name ("fs", "path"); nodejs_compat serves them as node:*.
		build.onResolve({ filter: BARE_BUILTIN }, (args) => ({ path: `node:${args.path}`, external: true }));
	},
};

let source = "";
if (workerPath) {
	// The site's own esbuild, else the tools' copy (npm ci --prefix tools).
	let esbuild;
	for (const from of [join(siteDir, "package.json"), new URL("./package.json", import.meta.url).pathname]) {
		try {
			esbuild = createRequire(from)("esbuild");
			break;
		} catch {}
	}
	if (!esbuild) fail("esbuild not found: add it to the site's devDependencies, or run 'npm ci --prefix tools'");
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
		plugins: [celldShims],
		minify,
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
if (!outDir) fail("usage: node tools/pack.ts <site-dir> <out-dir>");

// Walk the static directory without following symlinks: a link in a build folder
// could otherwise publish any file this user can read.
const files = (dir) =>
	readdirSync(dir).flatMap((n) => {
		const full = join(dir, n);
		const st = lstatSync(full);
		if (st.isSymbolicLink()) fail(`symlink in the static directory: ${relative(siteDir, full)} (copy the file instead)`);
		if (st.isDirectory()) return files(full);
		if (!st.isFile()) fail(`not a regular file: ${relative(siteDir, full)}`);
		if (st.size > MAX_FILE_BYTES) fail(`${relative(siteDir, full)} is ${st.size} bytes, limit ${MAX_FILE_BYTES}`);
		return [full];
	});
const assets = (assetsDir ? files(assetsDir) : [])
	.map((f) => relative(assetsDir, f).split("\\").join("/"))
	// _worker.js can also be a directory of server chunks (Cloudflare Pages output).
	.filter((p) => !SERVER_ONLY.has(p) && !p.startsWith("_worker.js/"))
	.sort()
	.map((path) => ({ path, type: TYPES[path.split(".").pop().toLowerCase()] ?? "application/octet-stream" }));

// Default immutable prefixes: only those the build really has, and assets/ only if
// it is Vite output (a content hash in every file name), not hand-written files
// like assets/logo.png that would then be cached for a year.
const HASHED = /[-.][A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;
let immutable = config.immutable;
if (immutable === undefined) {
	const under = (prefix) => assets.filter((a) => a.path.startsWith(prefix));
	immutable = ["_app/immutable/", "_nuxt/"].filter((p) => under(p).length);
	const vite = under("assets/");
	if (vite.length && vite.every((a) => HASHED.test(a.path))) immutable.push("assets/");
	else if (vite.length) console.error("pack: assets/ has files without a hash in their name; not caching it as immutable (set \"immutable\" in celld.json to override)");
}

const relevantMutable = mutable.filter((m) => assets.some((a) => a.path === m) && immutable.some((p) => m.startsWith(p)));
// The version id covers everything the router stores for it: options, server code,
// and each file's path, content type and bytes (NUL-separated, so no two inputs
// run together).
const hash = createHash("sha256")
	.update(JSON.stringify({ compatibilityDate, immutable, mutable: relevantMutable, notFound }))
	.update("\0")
	.update(source);
rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, "blobs"), { recursive: true });
const fileMap = {};
for (const a of assets) {
	const bytes = readFileSync(join(assetsDir, a.path));
	hash.update("\0").update(a.path).update("\0").update(a.type).update("\0").update(bytes);
	const sha = createHash("sha256").update(bytes).digest("hex");
	fileMap[a.path] = [sha, a.type];
	writeFileSync(join(outDir, "blobs", sha), bytes);
}
const version = hash.digest("hex").slice(0, 12);
writeFileSync(join(outDir, "version"), `${version}\n`);
writeFileSync(
	join(outDir, "code.json"),
	// `check` is how to deploy, not what is served, so it is not part of the version id.
	JSON.stringify({ compatibilityDate, source, files: fileMap, immutable, mutable: relevantMutable, notFound, check }),
);
console.error(
	`packed ${relative(process.cwd(), siteDir) || "."}: version ${version}, ${assets.length} assets, ` +
		(source ? `${source.length} bytes of server code` : "static only"),
);
