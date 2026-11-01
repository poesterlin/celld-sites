// The grain hosts: everything on grain-<id>.<domain> is either the one-time
// ticket handshake or a proxied request to celld, with identity headers added.
import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";
import { esc } from "./html.ts";
import { safePath } from "./path.ts";

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);

const text = (status, body) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

/** The shell's origin as this grain request's browser sees it. In home mode the
 *  shell is the same host on the public port. */
function shellOriginFor(core, event) {
	if (!core.home) return core.shellOrigin;
	const hostname = String(event.locals.browserHost ?? "").replace(/:\d+$/, "");
	return `http://${hostname}${core.config.publicPort ? `:${core.config.publicPort}` : ""}`;
}

/** The grain's own origin. In home mode, the host and port the browser used. */
const grainOriginFor = (core, event, grain) => (core.home ? `http://${event.locals.browserHost}` : core.grainOrigin(grain.id));

function grainNotice(core, status, grain, message, shellOrigin = core.shellOrigin) {
	const target = `${shellOrigin}/g/${grain.id}`;
	return new Response(
		`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${core.NAME}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:#18181b;background:#f4f4f6}
a{color:#5452e8}@media(prefers-color-scheme:dark){body{color:#f4f4f6;background:#0c0c10}a{color:#7c7bff}}</style>
<p>${esc(message)} <a href="${esc(target)}" target="_top">Open it in ${core.NAME}</a></p>`,
		{
			status,
			headers: {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
				"content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; frame-ancestors ${shellOrigin}`,
				"x-content-type-options": "nosniff",
			},
		},
	);
}

/** What a grain's pages may load and talk to, enforced by the browser on top of
 *  whatever policy the app sends itself. An app's server can only fetch the
 *  hosts its manifest declares (celld's egress allowlist); this holds its
 *  browser code to the same list. Without it, code in the page could load a
 *  script that changed after review, or send what people type anywhere. Inline
 *  and eval'd scripts stay allowed: frameworks need them, and they can only
 *  come from the reviewed bundle. Subdomains of a declared host count, for the
 *  media servers of a service like Mastodon. */
export function grainPolicy(egress: string[], shellOrigin: string): string {
	const hosts = egress.flatMap((h) => [`https://${h}`, `https://*.${h}`, `wss://${h}`]).join(" ");
	const plus = (list: string) => (hosts ? `${list} ${hosts}` : list);
	return [
		"default-src 'self'",
		"script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:",
		"style-src 'self' 'unsafe-inline'",
		plus("img-src 'self' data: blob:"),
		plus("media-src 'self' data: blob:"),
		"font-src 'self' data:",
		plus("connect-src 'self'"),
		"worker-src 'self' blob:",
		"frame-src 'self' blob:",
		"object-src 'none'",
		"base-uri 'self'",
		plus("form-action 'self'"),
		`frame-ancestors ${shellOrigin}`,
	].join("; ");
}

/** The one-time ticket handshake: trade the ticket for a grain session cookie. */
function enterGrain(core, event, grain, shellOrigin): Response {
	const value = event.url.searchParams.get("ticket") ?? "";
	const ticket = core.db.prepare("DELETE FROM tickets WHERE hash = ? RETURNING *").get(core.sha256(value));
	if (!ticket || ticket.grain_id !== grain.id || ticket.expires_at < Date.now()) return grainNotice(core, 403, grain, "This link to the grain has expired.", shellOrigin);
	const sessionValue = core.token(32);
	core.db
		.prepare("INSERT INTO grain_sessions (hash, grain_id, user_id, parent, public_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
		.run(core.sha256(sessionValue), grain.id, ticket.user_id, ticket.parent, core.randomId(16), Date.now(), Date.now() + core.GRAIN_SESSION_MS);
	return new Response(null, {
		status: 303,
		headers: {
			location: ticket.path,
			"set-cookie": `${core.GRAIN_COOKIE}=${sessionValue}; ${core.grainCookieAttrs}; Max-Age=${core.GRAIN_SESSION_MS / 1000}`,
			"cache-control": "no-store",
			"referrer-policy": "no-referrer",
		},
	});
}

/** Other sites, including other grains on the same domain, may navigate to a
 *  grain (a link) but not script it: no cross-origin subresource or fetch
 *  requests, and state changes only from the grain's own pages. */
function crossOriginRefused(core, event, grain): boolean {
	const request = event.request;
	const fetchSite = request.headers.get("sec-fetch-site");
	const navigate = request.headers.get("sec-fetch-mode") === "navigate";
	if (fetchSite !== null && fetchSite !== "same-origin" && fetchSite !== "none" && !navigate) return true;
	if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return false;
	if (fetchSite !== null) return fetchSite !== "same-origin";
	const origin = request.headers.get("origin");
	return origin !== null && origin !== grainOriginFor(core, event, grain);
}

/** What a visitor without a grain session gets: a bounce to sign in, or a refusal. */
function unauthenticated(core, event, grain, shellOrigin): Response {
	const request = event.request;
	const navigate = request.headers.get("sec-fetch-mode") === "navigate";
	const dest = request.headers.get("sec-fetch-dest");
	if ((request.method === "GET" || request.method === "HEAD") && navigate && dest !== "iframe") {
		const path = encodeURIComponent(safePath(event.url.pathname + event.url.search));
		return new Response(null, { status: 303, headers: { location: `${core.shellOrigin}/g/${grain.id}/open?path=${path}`, "cache-control": "no-store" } });
	}
	if (navigate) return grainNotice(core, 401, grain, "Your session for this grain ended.", shellOrigin);
	return text(401, "sign in to this grain first\n");
}

/** The browser's cookies minus the grain and shell session cookies. */
function foreignCookies(core, value: string): string {
	return value
		.split(";")
		.map((s) => s.trim())
		.filter((s) => s && !s.startsWith(`${core.GRAIN_COOKIE}=`) && !s.startsWith(`${core.SHELL_COOKIE}=`))
		.join("; ");
}

/** Headers the browser may not send itself: they say who is asking. */
const isReserved = (key: string) => HOP_BY_HOP.has(key) || key === "host" || key.startsWith("x-hamstr-") || key === "x-celld-proxy-token" || key === "x-forwarded-host";

/** The identity and routing headers Hamstr adds for celld. */
function identityHeaders(core, grain, visitor): Record<string, any> {
	const host = core.grainHost(grain.id);
	return {
		host,
		"x-forwarded-proto": core.config.scheme,
		"x-forwarded-host": host,
		"x-celld-proxy-token": core.config.proxyToken,
		"x-hamstr-grain-id": grain.id,
		"x-hamstr-session-id": visitor.gs.public_id,
		"x-hamstr-permissions": visitor.access.permissions.join(","),
		"x-hamstr-role": visitor.access.role,
		"x-hamstr-username": encodeURIComponent(visitor.user?.name ?? "Guest"),
		...(visitor.user && { "x-hamstr-user-id": core.publicUserId(visitor.user.id) }),
	};
}

/** Request headers for celld. Identity comes only from Hamstr: drop anything the
 *  browser sent under our header prefix, and the grain session cookie itself. */
function upstreamHeaders(core, request, grain, visitor): Record<string, any> {
	const headers: Record<string, any> = {};
	for (const [key, value] of request.headers) if (!isReserved(key)) headers[key] = value;
	if (headers.cookie !== undefined) {
		const kept = foreignCookies(core, String(headers.cookie));
		if (kept) headers.cookie = kept;
		else delete headers.cookie;
	}
	return Object.assign(headers, identityHeaders(core, grain, visitor));
}

/** A grain may set cookies for itself only: never for the parent domain (other
 *  grains, other services) and never ours. */
function ownCookies(core, value): string[] {
	return (Array.isArray(value) ? value : [value]).filter((cookie) => {
		const name = cookie.split("=")[0].trim();
		return !/;\s*domain\s*=/i.test(cookie) && name !== core.GRAIN_COOKIE && name !== core.SHELL_COOKIE;
	});
}

/** The grain's response headers: hop-by-hop dropped, cookies limited to the
 *  grain itself, and our policy added next to the app's own. */
function responseHeaders(core, up, egress: string[], shellOrigin: string): Headers {
	const out = new Headers();
	for (const [key, value] of Object.entries(up.headers) as [string, any][]) {
		if (HOP_BY_HOP.has(key)) continue;
		if (key === "set-cookie") for (const cookie of ownCookies(core, value)) out.append("set-cookie", cookie);
		else out.set(key, String(value));
	}
	// Two policies: the app's own (if any) and ours; the browser enforces both.
	const policy = out.get("content-security-policy");
	out.set("content-security-policy", [...(policy === null ? [] : [policy]), grainPolicy(egress, shellOrigin)].join(", "));
	out.set("x-robots-tag", "noindex");
	return out;
}

export async function grainRequest(event: any, grainId: string): Promise<Response> {
	const core = event.locals.core;
	const request = event.request;
	const grain = core.q.grain.get(grainId);
	if (!grain || grain.trashed_at) return text(404, "No such grain\n");
	const shellOrigin = shellOriginFor(core, event);
	// Mid-restore the data is half old, half new: nobody gets to see or change it.
	if (core.isRestoring(grain.id)) return grainNotice(core, 503, grain, "This item is being restored from a backup. Reload in a moment.", shellOrigin);

	const rawPath = event.url.pathname + event.url.search;
	const pathname = event.url.pathname;
	if (pathname === "/.hamstr/enter") return enterGrain(core, event, grain, shellOrigin);
	if (pathname.startsWith("/.hamstr/")) return text(404, "not found\n");
	if (crossOriginRefused(core, event, grain)) return text(403, "cross-origin request refused\n");

	const visitor = core.grainVisitor(request, grain);
	if (!visitor) return unauthenticated(core, event, grain, shellOrigin);
	const app = core.q.app.get(grain.slug);
	const egress: string[] = app ? (core.manifestOf(app).egress ?? []) : [];
	const headers = upstreamHeaders(core, request, grain, visitor);

	let resolveUpstream: (response: Response) => void;
	let rejectUpstream: (error: unknown) => void;
	const response = new Promise<Response>((resolvePromise, rejectPromise) => {
		resolveUpstream = resolvePromise;
		rejectUpstream = rejectPromise;
	});
	const upstream = httpRequest(
		{ hostname: core.sitesApi.hostname, port: core.sitesApi.port || 80, path: rawPath, method: request.method, headers, timeout: 120_000 },
		(up) => {
			const out = responseHeaders(core, up, egress, shellOrigin);
			const status = up.statusCode ?? 502;
			// 101/204/205/304 must not carry a body: `new Response` throws for one,
			// and a throw here is outside any handler (it would end the process).
			const bodyless = request.method === "HEAD" || status === 101 || status === 204 || status === 205 || status === 304;
			try {
				if (bodyless) up.resume();
				resolveUpstream(new Response(bodyless ? null : (Readable.toWeb(up) as any), { status, headers: out }));
			} catch (err) {
				up.destroy();
				rejectUpstream(err);
			}
		},
	);
	upstream.on("timeout", () => upstream.destroy(new Error("timeout")));
	upstream.on("error", (err) => rejectUpstream(err));
	if (request.body) {
		Readable.fromWeb(request.body).pipe(upstream);
	} else {
		upstream.end();
	}
	request.signal?.addEventListener("abort", () => upstream.destroy());

	try {
		return await response;
	} catch {
		return text(502, "the grain is not reachable right now\n");
	}
}

const EXTENSIONS = {
	"application/json": "json",
	"application/x-ndjson": "ndjson",
	"application/zip": "zip",
	"application/gzip": "gz",
	"application/x-tar": "tar",
	"application/vnd.sqlite3": "sqlite",
	"application/x-sqlite3": "sqlite",
	"application/xml": "xml",
	"text/csv": "csv",
	"text/plain": "txt",
	"text/markdown": "md",
	"text/html": "html",
	"text/calendar": "ics",
};
/** The extension for a download: the app's own filename's, else the type's. */
function extensionFor(type, disposition) {
	const suggested = /filename="?[^";]*\.([a-z0-9]{1,8})"?/i.exec(disposition ?? "")?.[1];
	return (suggested ?? EXTENSIONS[String(type ?? "").split(";")[0].trim().toLowerCase()] ?? "bin").toLowerCase();
}

/**
 * "Download data": ask the grain's app for its export path as the owner and
 * hand the answer back as an attachment. The app decides the format; Hamstr
 * names the file after the grain and keeps the browser from rendering it.
 */
export function grainExport(core, grain, user, path) {
	const host = core.grainHost(grain.id);
	const headers = {
		host,
		accept: "*/*",
		"x-forwarded-proto": core.config.scheme,
		"x-forwarded-host": host,
		"x-celld-proxy-token": core.config.proxyToken,
		"x-hamstr-grain-id": grain.id,
		"x-hamstr-session-id": core.randomId(16),
		"x-hamstr-permissions": core.accessFor(grain, { userId: user.id }).permissions.join(","),
		"x-hamstr-role": "owner",
		"x-hamstr-username": encodeURIComponent(user.name ?? ""),
		"x-hamstr-user-id": core.publicUserId(user.id),
		"x-hamstr-export": "1",
	};
	return new Promise((resolvePromise) => {
		const fail = (status, error) => resolvePromise(Response.json({ error }, { status, headers: { "cache-control": "no-store" } }));
		const upstream = httpRequest(
			{ hostname: core.sitesApi.hostname, port: core.sitesApi.port || 80, path, method: "GET", headers, timeout: 120_000 },
			(up) => {
				if (up.statusCode !== 200) {
					up.resume();
					return fail(502, `the app could not export this (it answered ${up.statusCode})`);
				}
				const day = new Date().toISOString().slice(0, 10);
				const base = `${grain.title} ${day}`.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, "-").slice(0, 120);
				const name = `${base}.${extensionFor(up.headers["content-type"], up.headers["content-disposition"])}`;
				const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/[%;]/g, "_");
				const out = new Headers({
					"content-type": up.headers["content-type"] ? String(up.headers["content-type"]) : "application/octet-stream",
					"content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
					"cache-control": "no-store",
					"x-content-type-options": "nosniff",
					"content-security-policy": "default-src 'none'; sandbox",
				});
				if (up.headers["content-length"]) out.set("content-length", String(up.headers["content-length"]));
				resolvePromise(new Response(Readable.toWeb(up) as any, { status: 200, headers: out }));
			},
		);
		upstream.on("timeout", () => upstream.destroy(new Error("timeout")));
		upstream.on("error", () => fail(502, "the app is not reachable right now"));
		upstream.end();
	});
}
