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
				"INSERT INTO grain_sessions (hash, grain_id, user_id, share_id, parent, public_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				core.sha256(sessionValue),
				grain.id,
				ticket.user_id,
				ticket.share_id,
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
			resolveUpstream(
				new Response(request.method === "HEAD" ? null : Readable.toWeb(up), {
					status: up.statusCode ?? 502,
					headers: out,
				}),
			);
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
