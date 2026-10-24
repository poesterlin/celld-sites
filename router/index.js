// One router Worker hosting many sites: any build that is a Workers `fetch`
// handler plus static files (SvelteKit, Nuxt/Nitro, TanStack Start, static-only).
// Each site's code lives in KV and runs in its own Dynamic Worker isolate. A
// request's hostname picks the site: an alias if one exists, otherwise the
// hostname itself is the site id. The site id (not the hostname) owns the
// site's versions and Durable Objects, so a site keeps its data under new names.
//   alias:<hostname>            -> site id
//   site:<site>                 -> current version id
//   code:<version>              -> { compatibilityDate, source, assets: [paths],
//                                    immutable: [prefixes], notFound }
//   asset:<version>:<path>      -> file bytes, metadata { type }
//   deploy:<site>:<iso time>    -> version, metadata { assets, sourceBytes }  (history)
//   obj:<site>|<class>|<name>   -> "", metadata { id, firstSeen }  (object index)
// Deploying uploads a version piece by piece (each file, then the code and file
// list), then activates it by flipping site:<site>, so visitors never see a
// half-written version. Activating an older version is a rollback.
//
// Requests: static files are served first, like Cloudflare's static assets
// (exact path, then <path>/index.html, then <path>.html), straight from KV
// without starting the site's isolate. Everything else goes to the site's
// worker; a static-only site answers 404 (or index.html with notFound "spa").
//
// Sites get two capabilities and nothing else:
//   ASSETS   their own static files
//   OBJECTS  their own Durable Objects. Each (site, class, name) is a SiteObject
//            supervisor that runs the site's class as a facet with its own
//            SQLite database. The hostname is fixed by the router, so a site
//            can never address another site's objects.
// Sites have no outbound network: celld's operator API on 127.0.0.1 has no
// authentication, and a site that can fetch it could stop the node or reach
// other sites' objects.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

// Runs in each site isolate before the site's own code, papering over APIs that
// celld 0.6.3 exposes but that throw "not implemented":
//  - console.createTask: libraries that feature-detect it (Nitro's hookable, so
//    every Nuxt site) then fail on every request. Removing it makes them take
//    their fallback path.
//  - process.nextTick: throws in celld. Nuxt/Nitro's process polyfill copies
//    nextTick from the global process object, and h3 then fails per request.
//    It is replaced with a queueMicrotask-based version.
//  - setImmediate: the global works today; a setTimeout-based stand-in is
//    installed only if it ever does not (Nitro prefers an existing global).
// The prelude must not import node:* modules: doing so breaks the site's own
// named imports from them ("does not provide an export named ...").
const PRELUDE = `
try { console.createTask?.("celld"); } catch {
	try { console.createTask = undefined; } catch {}
	if (console.createTask) Object.defineProperty(console, "createTask", { value: undefined, configurable: true, writable: true });
}

const throws = (fn) => { try { fn(); return false; } catch { return true; } };
const replace = (obj, name, value) => {
	try { obj[name] = value; } catch {}
	if (obj[name] !== value) { try { Object.defineProperty(obj, name, { value, configurable: true, writable: true }); } catch {} }
};

if (typeof globalThis.setImmediate !== "function" || throws(() => globalThis.clearImmediate(globalThis.setImmediate(() => {})))) {
	replace(globalThis, "setImmediate", (fn, ...args) => {
		const timer = setTimeout(fn, 0, ...args);
		return { timer, ref() { return this; }, unref() { return this; }, hasRef() { return true; } };
	});
	replace(globalThis, "clearImmediate", (handle) => { if (handle) clearTimeout(handle.timer ?? handle); });
}

const proc = globalThis.process;
if (proc && throws(() => proc.nextTick(() => {}))) {
	replace(proc, "nextTick", (fn, ...args) => queueMicrotask(() => fn(...args)));
}
`;
// The isolate's main module: prelude first (ES modules evaluate imports in
// order), then the site's handler and its Durable Object classes.
const MAIN = `import "./prelude.js";
export { default } from "./worker.js";
export * from "./worker.js";
`;

/** Load (or reuse) the isolate for one version of a site. */
function loadSite(env, exports, site, version) {
	return env.LOADER.get(`${site}@${version}`, async () => {
		const code = await env.CODE.get(`code:${version}`, "json");
		return {
			compatibilityDate: code.compatibilityDate,
			compatibilityFlags: ["nodejs_compat"],
			mainModule: "main.js",
			modules: { "main.js": MAIN, "prelude.js": PRELUDE, "worker.js": code.source },
			env: {
				ASSETS: exports.SiteAssets({ props: { version, immutable: code.immutable ?? DEFAULT_IMMUTABLE } }),
				OBJECTS: exports.SiteObjects({ props: { site } }),
			},
			globalOutbound: null, // fetch() and connect() throw inside sites
			limits: { cpuMs: 1000 },
		};
	});
}

/** Objects already in the index, so each costs one KV read per router isolate. */
const indexed = new Set();

/** Path prefixes of content-hashed build output: SvelteKit, Nuxt, Vite. */
const DEFAULT_IMMUTABLE = ["_app/immutable/", "_nuxt/", "assets/"];

/** One static file of a version, or null if it does not exist. */
async function assetResponse(env, version, path, immutable, { head = false, status = 200 } = {}) {
	const { value, metadata } = await env.CODE.getWithMetadata(`asset:${version}:${path}`, "arrayBuffer");
	if (value === null) return null;
	return new Response(head ? null : value, {
		status,
		headers: {
			"content-type": metadata?.type ?? "application/octet-stream",
			"cache-control": immutable.some((p) => path.startsWith(p)) ? "public, immutable, max-age=31536000" : "no-cache",
		},
	});
}

/** The ASSETS binding handed to each site: serves only that version's files. */
export class SiteAssets extends WorkerEntrypoint {
	async fetch(request) {
		let path;
		try {
			path = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, "");
		} catch {
			return new Response("Bad path", { status: 400 });
		}
		const { version, immutable = DEFAULT_IMMUTABLE } = this.ctx.props;
		return (
			(await assetResponse(this.env, version, path, immutable, { head: request.method === "HEAD" })) ??
			new Response("Not found", { status: 404 })
		);
	}
}

/** Routing facts per version (file list and options); the code record is read once. */
const metas = new Map();
async function siteMeta(env, version) {
	let meta = metas.get(version);
	if (!meta) {
		const code = await env.CODE.get(`code:${version}`, "json");
		meta = {
			legacy: !Array.isArray(code.assets), // deployed before file lists existed
			assets: new Set(code.assets ?? []),
			worker: Boolean(code.source),
			immutable: code.immutable ?? DEFAULT_IMMUTABLE,
			notFound: code.notFound ?? "none",
		};
		if (metas.size > 500) metas.clear();
		metas.set(version, meta);
	}
	return meta;
}

/** The static file a request path maps to, if any: exact, /index.html, .html. */
function assetFor(meta, pathname) {
	let path;
	try {
		path = decodeURIComponent(pathname).replace(/^\/+/, "");
	} catch {
		return undefined;
	}
	const candidates = path === "" || path.endsWith("/") ? [`${path}index.html`] : [path, `${path}/index.html`, `${path}.html`];
	return candidates.find((c) => meta.assets.has(c));
}

/** The OBJECTS binding handed to each site: `call(className, name, method, ...args)`
 *  runs an RPC method on that site's object. Arguments and results must be
 *  structured-cloneable (plain data). */
export class SiteObjects extends WorkerEntrypoint {
	async call(className, name, method, ...args) {
		const { site } = this.ctx.props;
		const ident = /^[A-Za-z_$][\w$]*$/;
		if (!ident.test(className) || !ident.test(method) || typeof name !== "string" || name.length > 200) {
			throw new Error("bad object reference");
		}
		const key = `${site}|${className}|${name}`;
		if (!indexed.has(key)) {
			indexed.add(key);
			this.ctx.waitUntil(indexObject(this.env, key));
		}
		const version = await this.env.CODE.get(`site:${site}`);
		return this.env.SITE_OBJECTS.getByName(key).handle(site, version, className, method, args);
	}
}

/** Record an object for the dashboard; object names are only hashes in storage. */
async function indexObject(env, key) {
	if ((await env.CODE.get(`obj:${key}`)) !== null) return;
	const id = env.SITE_OBJECTS.idFromName(key).toString();
	await env.CODE.put(`obj:${key}`, "", { metadata: { id, firstSeen: new Date().toISOString() } });
}

/** One per (site, class, name): runs the site's class as a facet. */
export class SiteObject extends DurableObject {
	async handle(site, version, className, method, args) {
		const worker = loadSite(this.env, this.ctx.exports, site, version);
		// The facet name selects the database, so data survives redeploys; a new
		// version only changes the class the facet is started from.
		if (this.version && this.version !== version) this.ctx.facets.abort(className, new Error("site redeployed"));
		this.version = version;
		const facet = this.ctx.facets.get(className, () => ({ class: worker.getDurableObjectClass(className) }));
		return facet[method](...args);
	}
}

/** Largest single static file (KV allows 25 MiB per value). */
const MAX_ASSET_BYTES = 20 * 1024 * 1024;
/** Largest code upload (bundled server code plus the file list). */
const MAX_CODE_BYTES = 16 * 1024 * 1024;
const VERSION = /^[a-f0-9]{12}$/;
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

const json = (body, status = 200) => Response.json(body, { status });
const fail = (status, error) => json({ error }, status);

/** True if the request's bearer token hashes (SHA-256) to `expectedHex`. Only the
 *  hashes are deployment vars, so the bucket never stores a usable token. */
async function bearerMatches(request, expectedHex) {
	const auth = request.headers.get("authorization") ?? "";
	if (!expectedHex || !/^[a-f0-9]{64}$/.test(expectedHex) || !auth.startsWith("Bearer ")) return false;
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(auth.slice(7))));
	const expected = Uint8Array.from(expectedHex.match(/../g), (h) => parseInt(h, 16));
	return crypto.subtle.timingSafeEqual(digest, expected);
}

/** Reject a body before reading it if it is larger than `max` bytes. */
function tooLarge(request, max) {
	const length = Number(request.headers.get("content-length"));
	if (!Number.isFinite(length) || request.headers.get("content-length") === null) return fail(411, "content-length required");
	if (length > max) return fail(413, `body is ${length} bytes, limit ${max}`);
	return null;
}

/** Every key under a prefix, following list cursors. */
async function listAll(kv, prefix) {
	const keys = [];
	let cursor;
	do {
		const page = await kv.list({ prefix, cursor });
		keys.push(...page.keys);
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	return keys;
}

/** Hostname -> site id, cached briefly so routing costs no extra KV read per request. */
const aliasCache = new Map();
async function siteFor(env, host) {
	const hit = aliasCache.get(host);
	if (hit && hit.until > Date.now()) return hit.site;
	const site = (await env.CODE.get(`alias:${host}`)) ?? host;
	if (aliasCache.size > 1000) aliasCache.clear();
	aliasCache.set(host, { site, until: Date.now() + 5000 });
	return site;
}

// --- Deploy: upload files, upload code, activate -------------------------------

/** PUT /__admin/asset?version=V&path=P  body: the file bytes, Content-Type: its type. */
async function putAsset(request, env, url) {
	const version = url.searchParams.get("version") ?? "";
	const path = url.searchParams.get("path") ?? "";
	if (!VERSION.test(version)) return fail(400, "bad version");
	if (!path || path.startsWith("/") || path.includes("\0") || new TextEncoder().encode(path).length > 400) return fail(400, "bad path");
	const big = tooLarge(request, MAX_ASSET_BYTES);
	if (big) return big;
	const bytes = await request.arrayBuffer();
	if (bytes.byteLength > MAX_ASSET_BYTES) return fail(413, "file too large");
	const type = request.headers.get("content-type") || "application/octet-stream";
	await env.CODE.put(`asset:${version}:${path}`, bytes, { metadata: { type } });
	return json({ version, path, bytes: bytes.byteLength });
}

/** PUT /__admin/code?version=V  body: { compatibilityDate, source, assets: [paths], immutable, notFound }.
 *  Refused unless every listed file was uploaded first. */
async function putCode(request, env, url) {
	const version = url.searchParams.get("version") ?? "";
	if (!VERSION.test(version)) return fail(400, "bad version");
	const big = tooLarge(request, MAX_CODE_BYTES);
	if (big) return big;
	let body;
	try {
		body = await request.json();
	} catch {
		return fail(400, "body is not JSON");
	}
	const { compatibilityDate, source = "", assets, immutable = DEFAULT_IMMUTABLE, notFound = "none" } = body;
	const valid =
		typeof compatibilityDate === "string" &&
		typeof source === "string" &&
		Array.isArray(assets) &&
		assets.every((a) => typeof a === "string") &&
		Array.isArray(immutable) &&
		immutable.every((p) => typeof p === "string") &&
		(notFound === "none" || notFound === "spa");
	if (!valid) return fail(400, "bad code record");
	const stored = new Set((await listAll(env.CODE, `asset:${version}:`)).map((k) => k.name.slice(`asset:${version}:`.length)));
	const missing = assets.filter((a) => !stored.has(a));
	if (missing.length) return fail(409, `missing ${missing.length} files, e.g. ${missing.slice(0, 3).join(", ")}`);
	await env.CODE.put(`code:${version}`, JSON.stringify({ compatibilityDate, source, assets, immutable, notFound }));
	return json({ version, assets: assets.length, sourceBytes: source.length });
}

/** POST /__admin/activate?host=H&version=V  points H's site at an uploaded version
 *  (a new deploy, or a rollback to an older one). */
async function activate(env, url) {
	const host = url.searchParams.get("host") ?? "";
	const version = url.searchParams.get("version") ?? "";
	if (!HOSTNAME.test(host) || !VERSION.test(version)) return fail(400, "bad host or version");
	const code = await env.CODE.get(`code:${version}`, "json");
	if (!code) return fail(404, `version ${version} is not uploaded (or was pruned)`);
	const site = await siteFor(env, host);
	await env.CODE.put(`site:${site}`, version); // the switch
	const summary = { assets: code.assets?.length ?? 0, sourceBytes: code.source?.length ?? 0 };
	await env.CODE.put(`deploy:${site}:${new Date().toISOString()}`, version, { metadata: summary });
	return json({ host, site, version, ...summary });
}

// --- Aliases -----------------------------------------------------------------

/** PUT /__admin/alias?host=H&site=S serves site S under hostname H as well (same
 *  versions, same objects). DELETE /__admin/alias?host=H removes it. */
async function alias(request, env, url) {
	const host = url.searchParams.get("host") ?? "";
	if (!HOSTNAME.test(host) || host === env.ADMIN_HOST) return fail(400, "bad host");
	if (request.method === "DELETE") {
		await env.CODE.delete(`alias:${host}`);
		aliasCache.delete(host);
		return json({ host, alias: null });
	}
	const site = url.searchParams.get("site") ?? "";
	if (!HOSTNAME.test(site)) return fail(400, "bad site");
	if (site === host) return fail(400, "a hostname already serves the site with its own name");
	if ((await env.CODE.get(`site:${site}`)) === null) return fail(404, `no site ${site}`);
	// Don't silently hide a hostname that is itself a deployed site.
	if ((await env.CODE.get(`site:${host}`)) !== null) return fail(409, `${host} is a site of its own; it would be hidden`);
	await env.CODE.put(`alias:${host}`, site);
	aliasCache.delete(host);
	return json({ host, site });
}

// --- Pruning -------------------------------------------------------------------

/** POST /__admin/prune?keep=N deletes stored versions except each site's current
 *  version and the N most recent versions in its deploy history (default 3). */
async function prune(env, url) {
	const keep = Math.max(0, Math.min(100, Number(url.searchParams.get("keep") ?? 3) || 0));
	const [siteKeys, deployKeys, codeKeys] = await Promise.all(["site:", "deploy:", "code:"].map((p) => listAll(env.CODE, p)));
	const kept = new Set();
	for (const k of siteKeys) kept.add(await env.CODE.get(k.name));
	const history = new Map(); // site -> [{ at, version }]
	for (const k of deployKeys) {
		const rest = k.name.slice("deploy:".length);
		const site = rest.slice(0, rest.indexOf(":")); // site ids are hostnames: no ":"
		const list = history.get(site) ?? [];
		list.push({ at: rest.slice(site.length + 1), key: k.name });
		history.set(site, list);
	}
	for (const list of history.values()) {
		list.sort((a, b) => b.at.localeCompare(a.at));
		const recent = [];
		for (const entry of list) {
			const version = await env.CODE.get(entry.key);
			if (!recent.includes(version)) recent.push(version);
			if (recent.length >= keep) break;
		}
		recent.forEach((v) => kept.add(v));
	}
	const deleted = [];
	for (const k of codeKeys) {
		const version = k.name.slice("code:".length);
		if (kept.has(version)) continue;
		for (const a of await listAll(env.CODE, `asset:${version}:`)) await env.CODE.delete(a.name);
		await env.CODE.delete(k.name);
		deleted.push(version);
	}
	return json({ keep, kept: [...kept].filter(Boolean), deleted });
}

// --- Read-only ------------------------------------------------------------------

/** GET /__admin/overview: sites (with aliases), deploy history, versions, object index. */
async function overview(env) {
	const [siteKeys, aliasKeys, deployKeys, objKeys, codeKeys] = await Promise.all(
		["site:", "alias:", "deploy:", "obj:", "code:"].map((p) => listAll(env.CODE, p)),
	);
	const aliases = await Promise.all(aliasKeys.map(async (k) => ({ host: k.name.slice(6), site: await env.CODE.get(k.name) })));
	const sites = await Promise.all(
		siteKeys.map(async (k) => {
			const id = k.name.slice(5);
			return { id, version: await env.CODE.get(k.name), aliases: aliases.filter((a) => a.site === id).map((a) => a.host) };
		}),
	);
	const deploys = await Promise.all(
		deployKeys.map(async (k) => {
			const rest = k.name.slice(7); // <site>:<iso time>
			const at = rest.slice(rest.indexOf(":") + 1);
			return { site: rest.slice(0, rest.indexOf(":")), at, version: await env.CODE.get(k.name), ...k.metadata };
		}),
	);
	const objects = objKeys.map((k) => {
		const rest = k.name.slice(4);
		const first = rest.indexOf("|");
		const second = rest.indexOf("|", first + 1);
		return { site: rest.slice(0, first), className: rest.slice(first + 1, second), name: rest.slice(second + 1), ...k.metadata };
	});
	const versions = await Promise.all(
		codeKeys.map(async (k) => {
			const version = k.name.slice(5);
			return { version, assets: (await listAll(env.CODE, `asset:${version}:`)).length };
		}),
	);
	return json({ sites, aliases, deploys, objects, versions });
}

/** GET /__admin/state: celld's live node counters (the only operator call made). */
async function nodeState() {
	const res = await fetch("http://127.0.0.1:8081/state", { signal: AbortSignal.timeout(5000) });
	return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
}

/** The admin API. Writes need the deploy token; the read-only GETs also accept the read token. */
async function admin(request, env, url) {
	const { pathname } = url;
	const method = request.method;
	const isAdmin = await bearerMatches(request, env.ADMIN_TOKEN_SHA256);
	if (method === "GET" && (pathname === "/__admin/overview" || pathname === "/__admin/state")) {
		if (!isAdmin && !(await bearerMatches(request, env.READ_TOKEN_SHA256))) return fail(403, "forbidden");
		return pathname === "/__admin/overview" ? overview(env) : nodeState();
	}
	if (!isAdmin) return fail(403, "forbidden");
	if (method === "PUT" && pathname === "/__admin/asset") return putAsset(request, env, url);
	if (method === "PUT" && pathname === "/__admin/code") return putCode(request, env, url);
	if (method === "POST" && pathname === "/__admin/activate") return activate(env, url);
	if ((method === "PUT" || method === "DELETE") && pathname === "/__admin/alias") return alias(request, env, url);
	if (method === "POST" && pathname === "/__admin/prune") return prune(env, url);
	return fail(404, "not found");
}

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		const host = url.hostname;
		// The admin API answers only on an internal hostname that Traefik never
		// routes, so only the project's containers reach it, and every call needs a token.
		if (host === env.ADMIN_HOST) return admin(request, env, url);

		const site = await siteFor(env, host);
		const version = await env.CODE.get(`site:${site}`);
		if (!version) return new Response(`No site for ${host}`, { status: 404 });

		const meta = await siteMeta(env, version);
		const head = request.method === "HEAD";
		if (!meta.legacy && (request.method === "GET" || head)) {
			const path = assetFor(meta, url.pathname);
			const res = path && (await assetResponse(env, version, path, meta.immutable, { head }));
			if (res) return res;
		}
		if (!meta.legacy && !meta.worker) {
			// Static-only site: optional SPA fallback for page navigations (not for
			// missing scripts or images), then 404.html, then a bare 404.
			const navigation = (request.headers.get("accept") ?? "").includes("text/html");
			if ((request.method === "GET" || head) && navigation && meta.notFound === "spa" && meta.assets.has("index.html")) {
				return assetResponse(env, version, "index.html", meta.immutable, { head });
			}
			const notFound = meta.assets.has("404.html") && (await assetResponse(env, version, "404.html", meta.immutable, { head, status: 404 }));
			return notFound || new Response("Not found", { status: 404 });
		}

		// Traefik terminates TLS and forwards plain HTTP. Hand sites the URL the
		// browser used, so origins match (SvelteKit's CSRF check, redirects, cookies).
		let siteRequest = request;
		if (url.protocol === "http:" && request.headers.get("x-forwarded-proto") === "https") {
			url.protocol = "https:";
			siteRequest = new Request(url, request);
		}

		// Compiled once per version; later requests reuse the warm isolate.
		return loadSite(env, ctx.exports, site, version).getEntrypoint().fetch(siteRequest);
	},
};
