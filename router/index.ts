// One router Worker hosting many sites: any build that is a Workers `fetch`
// handler plus static files (SvelteKit, Nuxt/Nitro, TanStack Start, static-only).
// Each site's code lives in KV and runs in its own Dynamic Worker isolate. A
// request's hostname picks the site: an alias if one exists, otherwise the
// hostname itself is the site id. The site id (not the hostname) owns the
// site's versions and Durable Objects, so a site keeps its data under new names.
//   alias:<hostname>            -> site id
//   site:<site>                 -> current version id
//   code:<version>              -> { compatibilityDate, source, files: { path: [sha256, type] },
//                                    immutable: [prefixes], mutable: [paths], notFound },
//                                  metadata { files }  (the file count)
//   blob:<sha256>               -> file bytes, metadata { at }  (shared by every
//                                  version, of any site, that has the file)
//   asset:<version>:<path>      -> file bytes, metadata { type }  (versions uploaded
//                                  before blobs: code has assets: [paths], no files)
//   deploy:<site>:<iso time>    -> version, metadata { assets, sourceBytes, auth }  (history)
//   staged:<site>:<version>     -> "", metadata { at, auth }  (uploaded for that site, not
//                                  necessarily active; auth = its celld.json sign-in mode)
//   auth:<site>                 -> { declared, override }  (sign-in mode; see "Sign-in")
//   obj:<site>|<class>|<name>   -> "", metadata { id, firstSeen }  (object index)
// Deploying uploads a version piece by piece (the files the router doesn't have
// yet, then the code and file list), then activates it by flipping site:<site>,
// so visitors never see a half-written version. Activating an older version is a
// rollback.
//
// Requests: static files are served first, like Cloudflare's static assets
// (exact path, then <path>/index.html, then <path>.html), straight from KV
// without starting the site's isolate. Everything else goes to the site's
// worker; a static-only site answers 404 (or index.html with notFound "spa").
//
// Sites get three capabilities and nothing else:
//   ASSETS   their own static files
//   OBJECTS  their own Durable Objects. Each (site, class, name) is a SiteObject
//            supervisor that runs the site's class as a facet with its own
//            SQLite database. The hostname is fixed by the router, so a site
//            can never address another site's objects.
//   AUTH     (not a binding) sites that declare `auth` in celld.json get a verified
//            identity as x-celld-user-* headers; see "Sign-in" at the end of this
//            file and docs/SECURITY.md.
//   EGRESS   outbound fetch() to the hosts the operator allowlisted for that
//            site (egress:<site> in KV). Off by default: celld's operator API
//            on 127.0.0.1 has no authentication, and a site that can fetch it
//            could stop the node or reach other sites' objects. The proxy checks
//            every request against the list, refuses IP literals and internal
//            names, and does not follow redirects (the site follows them, so
//            the next hop is checked too). connect() stays unavailable.
//
// Layout (this file only routes; celld finds the Durable Object and entrypoint
// classes through the re-exports below):
//   admin/    the /__admin API, one file per concern (deploy, prune, backup, ...)
//   auth/     sign-in: signed tokens, per-site policy, cookies, the callback
//   egress/   the allowlist cache and the SiteEgress proxy
//   isolate/  what runs inside a site's isolate, and loading it
//   objects/  SiteObjects (the OBJECTS binding), SiteObject, the object index
//   serve/    static files, the version's routing facts, per-site limits
//   lib/      small shared helpers (responses, KV listing, ids, timeouts)

import { admin } from "./admin/index.ts";
import { signIn } from "./auth/signin.ts";
import { tokenMatches } from "./lib/http.ts";
import { siteFor } from "./lib/sites.ts";

export { SiteAssets } from "./serve/assets.ts";
export { SiteEgress } from "./egress/proxy.ts";
export { SiteObject } from "./objects/site-object.ts";
export { SiteObjects } from "./objects/bindings.ts";

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		const host = url.hostname;
		// The admin API answers only on an internal hostname that Traefik never
		// routes, so only the project's containers reach it, and every call needs a token.
		if (host === env.ADMIN_HOST) return admin(request, env, ctx, url);

		let site = await siteFor(env, host);
		let version = await env.CODE.get(`site:${site}`);
		// Local previews (tools/preview.sh) set DEFAULT_SITE so the one site answers on
		// any hostname (localhost, an IP); production leaves it empty.
		if (!version && env.DEFAULT_SITE) {
			site = env.DEFAULT_SITE;
			version = await env.CODE.get(`site:${site}`);
		}
		if (!version) return new Response(`No site for ${host}`, { status: 404 });
		// Sites under PROXY_SITE_PREFIX (Hamster grains) belong to a front proxy
		// that authenticates the visitor and sets identity headers. Only that proxy
		// knows the token, so another container on the bridge cannot reach a grain
		// directly or forge its identity headers.
		const proxied = proxyPrefix(env) !== "" && site.startsWith(proxyPrefix(env));
		const supplied = request.headers.get(PROXY_HEADER);
		if (proxied && !(await tokenMatches(supplied, env.PROXY_TOKEN_SHA256))) return new Response(`No site for ${host}`, { status: 404 });
		if (supplied !== null) {
			const headers = new Headers(request.headers);
			headers.delete(PROXY_HEADER);
			request = new Request(request, { headers });
		}
		return signIn(request, env, ctx, site, version);
	},
};

const PROXY_HEADER = "x-celld-proxy-token";
/** An unreplaced template placeholder (an older preview script) disables the check. */
const proxyPrefix = (env) => (/^[a-z0-9][a-z0-9.-]*$/.test(env.PROXY_SITE_PREFIX ?? "") ? env.PROXY_SITE_PREFIX : "");
