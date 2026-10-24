// One router Worker hosting many sites: any build that is a Workers `fetch`
// handler plus static files (SvelteKit, Nuxt/Nitro, TanStack Start, static-only).
// Each site's code lives in KV and runs in its own Dynamic Worker isolate,
// picked by hostname:
//   site:<host>                 -> current version id
//   code:<version>              -> { compatibilityDate, source, assets: [paths],
//                                    immutable: [prefixes], notFound }
//   asset:<version>:<path>      -> file bytes, metadata { type }
//   deploy:<host>:<iso time>    -> version, metadata { assets, sourceBytes }  (history)
//   obj:<host>|<class>|<name>   -> "", metadata { id, firstSeen }  (object index)
// Deploying writes a new version, then flips site:<host> as the last step, so
// visitors never see a half-written version.
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

/** Load (or reuse) the isolate for one version of a site. */
function loadSite(env, exports, host, version) {
	return env.LOADER.get(`${host}@${version}`, async () => {
		const code = await env.CODE.get(`code:${version}`, "json");
		return {
			compatibilityDate: code.compatibilityDate,
			compatibilityFlags: ["nodejs_compat"],
			mainModule: "worker.js",
			modules: { "worker.js": code.source },
			env: {
				ASSETS: exports.SiteAssets({ props: { version, immutable: code.immutable ?? DEFAULT_IMMUTABLE } }),
				OBJECTS: exports.SiteObjects({ props: { host } }),
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
		const { host } = this.ctx.props;
		const ident = /^[A-Za-z_$][\w$]*$/;
		if (!ident.test(className) || !ident.test(method) || typeof name !== "string" || name.length > 200) {
			throw new Error("bad object reference");
		}
		const key = `${host}|${className}|${name}`;
		if (!indexed.has(key)) {
			indexed.add(key);
			this.ctx.waitUntil(indexObject(this.env, key));
		}
		const version = await this.env.CODE.get(`site:${host}`);
		return this.env.SITE_OBJECTS.getByName(key).handle(host, version, className, method, args);
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
	async handle(host, version, className, method, args) {
		const worker = loadSite(this.env, this.ctx.exports, host, version);
		// The facet name selects the database, so data survives redeploys; a new
		// version only changes the class the facet is started from.
		if (this.version && this.version !== version) this.ctx.facets.abort(className, new Error("site redeployed"));
		this.version = version;
		const facet = this.ctx.facets.get(className, () => ({ class: worker.getDurableObjectClass(className) }));
		return facet[method](...args);
	}
}

const sameToken = (a, b) => {
	const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
	return x.length === y.length && crypto.subtle.timingSafeEqual(x, y);
};

/** POST /__admin/deploy?host=<hostname> with a payload from tools/pack.mjs. Old
 *  versions stay in KV, so a rollback is pointing site:<host> back at one. */
async function deploy(request, env, url) {
	if (request.method !== "POST" || !sameToken(request.headers.get("authorization") ?? "", `Bearer ${env.ADMIN_TOKEN}`)) {
		return new Response("Forbidden", { status: 403 });
	}
	const host = url.searchParams.get("host") ?? "";
	const { version, compatibilityDate, source = "", assets, immutable = DEFAULT_IMMUTABLE, notFound = "none" } = await request.json();
	const validOptions =
		Array.isArray(immutable) && immutable.every((p) => typeof p === "string") && (notFound === "none" || notFound === "spa");
	if (!/^[a-z0-9.-]+$/.test(host) || !/^[a-f0-9]{12}$/.test(version) || typeof source !== "string" || !validOptions) {
		return new Response("Bad request", { status: 400 });
	}
	for (const a of assets) {
		const bytes = Uint8Array.from(atob(a.b64), (c) => c.charCodeAt(0));
		await env.CODE.put(`asset:${version}:${a.path}`, bytes, { metadata: { type: a.type } });
	}
	const paths = assets.map((a) => a.path);
	await env.CODE.put(`code:${version}`, JSON.stringify({ compatibilityDate, source, assets: paths, immutable, notFound }));
	await env.CODE.put(`site:${host}`, version); // the switch
	const summary = { assets: assets.length, sourceBytes: source.length };
	await env.CODE.put(`deploy:${host}:${new Date().toISOString()}`, version, { metadata: summary });
	return Response.json({ host, version, ...summary });
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

/** GET /__admin/overview: sites, deploy history, versions and the object index. */
async function overview(env) {
	const [siteKeys, deployKeys, objKeys, codeKeys] = await Promise.all(
		["site:", "deploy:", "obj:", "code:"].map((p) => listAll(env.CODE, p)),
	);
	const sites = await Promise.all(
		siteKeys.map(async (k) => ({ host: k.name.slice(5), version: await env.CODE.get(k.name) })),
	);
	const deploys = await Promise.all(
		deployKeys.map(async (k) => {
			const rest = k.name.slice(7); // <host>:<iso time>
			const at = rest.slice(rest.indexOf(":") + 1);
			return { host: rest.slice(0, rest.indexOf(":")), at, version: await env.CODE.get(k.name), ...k.metadata };
		}),
	);
	const objects = objKeys.map((k) => {
		const [host, className, name] = k.name.slice(4).split("|");
		return { host, className, name, ...k.metadata };
	});
	const versions = await Promise.all(
		codeKeys.map(async (k) => {
			const version = k.name.slice(5);
			return { version, assets: (await listAll(env.CODE, `asset:${version}:`)).length };
		}),
	);
	return Response.json({ sites, deploys, objects, versions });
}

/** GET /__admin/state: celld's live node counters (the only operator call made). */
async function nodeState() {
	const res = await fetch("http://127.0.0.1:8081/state", { signal: AbortSignal.timeout(5000) });
	return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
}

/** The admin API: deploys need ADMIN_TOKEN; the read-only GETs also accept READ_TOKEN. */
function admin(request, env, url) {
	const auth = request.headers.get("authorization") ?? "";
	if (url.pathname === "/__admin/deploy") return deploy(request, env, url);
	const reader = sameToken(auth, `Bearer ${env.READ_TOKEN}`) || sameToken(auth, `Bearer ${env.ADMIN_TOKEN}`);
	if (request.method !== "GET" || !reader) return new Response("Forbidden", { status: 403 });
	if (url.pathname === "/__admin/overview") return overview(env);
	if (url.pathname === "/__admin/state") return nodeState();
	return new Response("Not found", { status: 404 });
}

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		const host = url.hostname;
		// The admin API answers only on an internal hostname that Traefik never
		// routes, so only the project's containers reach it, and every call needs a token.
		if (host === env.ADMIN_HOST) return admin(request, env, url);

		const version = await env.CODE.get(`site:${host}`);
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
		return loadSite(env, ctx.exports, host, version).getEntrypoint().fetch(siteRequest);
	},
};
