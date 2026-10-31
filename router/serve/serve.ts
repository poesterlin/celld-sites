import { loadSite } from "../isolate/load.ts";
import { Timeout, timeoutMs, withTimeout } from "../lib/limits.ts";
import { assetResponse } from "./assets.ts";
import { assetFor, siteMeta } from "./meta.ts";

/** Answer a request with one version of a site: static files first, then its worker. */
export async function serve(request, env, ctx, site, version) {
	const url = new URL(request.url);
	const meta = await siteMeta(env, version);
	const head = request.method === "HEAD";
	if (!meta.legacy && (request.method === "GET" || head)) {
		const path = assetFor(meta, url.pathname);
		const res = path && (await assetResponse(env, version, path, meta, { head, request, known: true }));
		if (res) return res;
	}
	if (!meta.legacy && !meta.worker) {
		// Static-only site: optional SPA fallback for page navigations (not for
		// missing scripts or images), then 404.html, then a bare 404.
		const navigation = (request.headers.get("accept") ?? "").includes("text/html");
		if ((request.method === "GET" || head) && navigation && meta.notFound === "spa" && meta.assets.has("index.html")) {
			return assetResponse(env, version, "index.html", meta, { head, request, known: true });
		}
		const notFound = meta.assets.has("404.html") && (await assetResponse(env, version, "404.html", meta, { head, status: 404 }));
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
	try {
		return await withTimeout((await loadSite(env, ctx.exports, site, version)).getEntrypoint().fetch(siteRequest), timeoutMs(env), "the site");
	} catch (e) {
		if (e instanceof Timeout) return new Response(`${e.message}\n`, { status: 504 });
		throw e;
	}
}
