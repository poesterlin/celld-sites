// The grain hosts: everything on grain-<id>.<domain> is either the one-time
// ticket handshake or a proxied request to celld, with identity headers added.
import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";
import { esc } from "./html.mjs";
import { safePath } from "./path.mjs";

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);

const text = (status, body) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

function grainNotice(core, status, grain, message) {
	const target = `${core.shellOrigin}/g/${grain.id}`;
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
				"content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; frame-ancestors ${core.shellOrigin}`,
				"x-content-type-options": "nosniff",
			},
		},
	);
}

export async function grainRequest(event, grainId) {
	const core = event.locals.core;
	const request = event.request;
	const grain = core.q.grain.get(grainId);
	if (!grain || grain.trashed_at) return text(404, "No such grain\n");
	// Mid-restore the data is half old, half new: nobody gets to see or change it.
	if (core.isRestoring(grain.id)) return grainNotice(core, 503, grain, "This item is being restored from a backup. Reload in a moment.");

	const rawPath = event.url.pathname + event.url.search;
	const pathname = event.url.pathname;
	const fetchSite = request.headers.get("sec-fetch-site");
	const navigate = request.headers.get("sec-fetch-mode") === "navigate";

	if (pathname === "/.hamstr/enter") {
		const value = event.url.searchParams.get("ticket") ?? "";
		const ticket = core.db.prepare("DELETE FROM tickets WHERE hash = ? RETURNING *").get(core.sha256(value));
		if (!ticket || ticket.grain_id !== grain.id || ticket.expires_at < Date.now()) return grainNotice(core, 403, grain, "This link to the grain has expired.");
		const sessionValue = core.token(32);
		core.db
			.prepare(
				"INSERT INTO grain_sessions (hash, grain_id, user_id, parent, public_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				core.sha256(sessionValue),
				grain.id,
				ticket.user_id,
				ticket.parent,
				core.randomId(16),
				Date.now(),
				Date.now() + core.GRAIN_SESSION_MS,
			);
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
	if (pathname.startsWith("/.hamstr/")) return text(404, "not found\n");

	// Other sites, including other grains on the same domain, may navigate to a
	// grain (a link) but not script it: no cross-origin subresource or fetch
	// requests, and state changes only from the grain's own pages.
	const unsafe = !["GET", "HEAD", "OPTIONS"].includes(request.method);
	if (fetchSite !== null && fetchSite !== "same-origin" && fetchSite !== "none" && !navigate) return text(403, "cross-origin request refused\n");
	if (unsafe) {
		const ok = fetchSite !== null ? fetchSite === "same-origin" : request.headers.get("origin") === null || request.headers.get("origin") === core.grainOrigin(grain.id);
		if (!ok) return text(403, "cross-origin request refused\n");
	}

	const visitor = core.grainVisitor(request, grain);
	if (!visitor) {
		const dest = request.headers.get("sec-fetch-dest");
		if ((request.method === "GET" || request.method === "HEAD") && navigate && dest !== "iframe") {
			return new Response(null, {
				status: 303,
				headers: { location: `${core.shellOrigin}/g/${grain.id}/open?path=${encodeURIComponent(safePath(rawPath))}`, "cache-control": "no-store" },
			});
		}
		if (navigate) return grainNotice(core, 401, grain, "Your session for this grain ended.");
		return text(401, "sign in to this grain first\n");
	}

	// Forward. Identity comes only from Hamstr: drop anything the browser sent
	// under our header prefix, and the grain session cookie itself.
	const headers = {};
	for (const [key, value] of request.headers) {
		if (HOP_BY_HOP.has(key) || key === "host" || key.startsWith("x-hamstr-") || key === "x-celld-proxy-token" || key === "x-forwarded-host") continue;
		if (key === "cookie") {
			const kept = String(value)
				.split(";")
				.map((s) => s.trim())
				.filter((s) => s && !s.startsWith(`${core.GRAIN_COOKIE}=`) && !s.startsWith(`${core.SHELL_COOKIE}=`));
			if (kept.length) headers.cookie = kept.join("; ");
			continue;
		}
		headers[key] = value;
	}
	const host = core.grainHost(grain.id);
	Object.assign(headers, {
		host,
		"x-forwarded-proto": core.config.scheme,
		"x-forwarded-host": host,
		"x-celld-proxy-token": core.config.proxyToken,
		"x-hamstr-grain-id": grain.id,
		"x-hamstr-session-id": visitor.gs.public_id,
		"x-hamstr-permissions": visitor.access.permissions.join(","),
		"x-hamstr-role": visitor.access.role,
		"x-hamstr-username": encodeURIComponent(visitor.user?.name ?? "Guest"),
	});
	if (visitor.user) headers["x-hamstr-user-id"] = core.publicUserId(visitor.user.id);

	const upstream = httpRequest(
		{ hostname: core.sitesApi.hostname, port: core.sitesApi.port || 80, path: rawPath, method: request.method, headers, timeout: 120_000 },
		(up) => {
			const out = new Headers();
			for (const [key, value] of Object.entries(up.headers)) {
				if (HOP_BY_HOP.has(key)) continue;
				if (key === "set-cookie") {
					// A grain may set cookies for itself only: never for the parent
					// domain (other grains, other services) and never ours.
					for (const cookie of Array.isArray(value) ? value : [value]) {
						const name = cookie.split("=")[0].trim();
						if (!/;\s*domain\s*=/i.test(cookie) && name !== core.GRAIN_COOKIE && name !== core.SHELL_COOKIE) out.append("set-cookie", cookie);
					}
					continue;
				}
				out.set(key, String(value));
			}
			const policy = out.get("content-security-policy");
			out.set("content-security-policy", [...(policy === null ? [] : [policy]), `frame-ancestors ${core.shellOrigin}`].join(", "));
			out.set("x-robots-tag", "noindex");
			const status = up.statusCode ?? 502;
			// 101/204/205/304 must not carry a body: `new Response` throws for one,
			// and a throw here is outside any handler (it would end the process).
			const bodyless = request.method === "HEAD" || status === 101 || status === 204 || status === 205 || status === 304;
			try {
				if (bodyless) up.resume();
				resolveUpstream(new Response(bodyless ? null : Readable.toWeb(up), { status, headers: out }));
			} catch (err) {
				up.destroy();
				rejectUpstream(err);
			}
		},
	);

	let resolveUpstream;
	let rejectUpstream;
	const response = new Promise((resolvePromise, rejectPromise) => {
		resolveUpstream = resolvePromise;
		rejectUpstream = rejectPromise;
	});
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
				resolvePromise(new Response(Readable.toWeb(up), { status: 200, headers: out }));
			},
		);
		upstream.on("timeout", () => upstream.destroy(new Error("timeout")));
		upstream.on("error", () => fail(502, "the app is not reachable right now"));
		upstream.end();
	});
}
