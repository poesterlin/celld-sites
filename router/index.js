// One router Worker hosting many SvelteKit sites. Each site's code lives in KV
// and runs in its own Dynamic Worker isolate, picked by hostname:
//   site:<host>            -> current version id
//   code:<version>         -> { compatibilityDate, source }   (bundled server code)
//   asset:<version>:<path> -> file bytes, metadata { type }
// Deploying writes a new version, then flips site:<host> as the last step, so
// visitors never see a half-written version.
//
// Sites get two capabilities and nothing else:
//   ASSETS   their own static files
//   OBJECTS  their own Durable Objects. Each (site, class, name) is a SiteObject
//            supervisor that runs the site's class as a facet with its own
//            SQLite database. The hostname is fixed by the router, so a site
//            can never address another site's objects.
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
				ASSETS: exports.SiteAssets({ props: { version } }),
				OBJECTS: exports.SiteObjects({ props: { host } }),
			},
			limits: { cpuMs: 1000 },
		};
	});
}

/** The ASSETS binding handed to each site: serves only that version's files. */
export class SiteAssets extends WorkerEntrypoint {
	async fetch(request) {
		const path = decodeURIComponent(new URL(request.url).pathname).replace(/^\/+/, "");
		const { value, metadata } = await this.env.CODE.getWithMetadata(`asset:${this.ctx.props.version}:${path}`, "arrayBuffer");
		if (value === null) return new Response("Not found", { status: 404 });
		return new Response(value, {
			headers: {
				"content-type": metadata?.type ?? "application/octet-stream",
				"cache-control": path.startsWith("_app/immutable/") ? "public, immutable, max-age=31536000" : "no-cache",
			},
		});
	}
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
		const version = await this.env.CODE.get(`site:${host}`);
		return this.env.SITE_OBJECTS.getByName(`${host}|${className}|${name}`).handle(host, version, className, method, args);
	}
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
	const { version, compatibilityDate, source, assets } = await request.json();
	if (!/^[a-z0-9.-]+$/.test(host) || !/^[a-f0-9]{12}$/.test(version)) return new Response("Bad request", { status: 400 });
	for (const a of assets) {
		const bytes = Uint8Array.from(atob(a.b64), (c) => c.charCodeAt(0));
		await env.CODE.put(`asset:${version}:${a.path}`, bytes, { metadata: { type: a.type } });
	}
	await env.CODE.put(`code:${version}`, JSON.stringify({ compatibilityDate, source }));
	await env.CODE.put(`site:${host}`, version); // the switch
	return Response.json({ host, version, assets: assets.length, sourceBytes: source.length });
}

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		const host = url.hostname;
		// The admin API answers only on an internal hostname that Traefik never
		// routes, so it is reachable from inside the container alone (plus the token).
		if (host === env.ADMIN_HOST) {
			return url.pathname === "/__admin/deploy" ? deploy(request, env, url) : new Response("Not found", { status: 404 });
		}

		const version = await env.CODE.get(`site:${host}`);
		if (!version) return new Response(`No site for ${host}`, { status: 404 });

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
