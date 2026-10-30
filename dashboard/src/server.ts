// Read-only dashboard for celld-sites. Every route except /health needs HTTP
// Basic auth (DASHBOARD_PASSWORD), and it serves GET/HEAD only: no route changes
// anything. It also reads the bucket (read-only mount) for storage sizes.
import { createHash, timingSafeEqual } from "node:crypto";
import { config, getModel } from "./data";
import { notFoundPage, overviewPage, sitePage } from "./ui";

const HEADERS = {
	// No scripts at all; inline styles only (the page's CSS and usage bar widths).
	"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
};
const html = (body: string, status = 200) =>
	new Response(body, { status, headers: { ...HEADERS, "content-type": "text/html; charset=utf-8" } });

// Compare digests, so the check takes the same time wherever the guess differs.
const digest = (s: string) => createHash("sha256").update(s).digest();
const passwordDigest = digest(config.password);
function authorized(req: Request): boolean {
	const m = /^Basic ([A-Za-z0-9+/=]+)$/.exec(req.headers.get("authorization") ?? "");
	if (!m) return false;
	const given = Buffer.from(m[1]!, "base64").toString("utf8");
	const colon = given.indexOf(":");
	if (colon < 0) return false;
	const userOk = timingSafeEqual(digest(given.slice(0, colon)), digest(config.user));
	const passOk = timingSafeEqual(digest(given.slice(colon + 1)), passwordDigest);
	return userOk && passOk;
}

Bun.serve({
	port: config.port,
	async fetch(req) {
		if (req.method !== "GET" && req.method !== "HEAD") {
			return new Response("Read-only", { status: 405, headers: { allow: "GET, HEAD" } });
		}
		const { pathname } = new URL(req.url);
		if (pathname === "/health") return new Response("ok");
		if (!authorized(req)) {
			// Slow down guessing; the page itself is only a few bytes.
			await Bun.sleep(500);
			return new Response("Authentication required", {
				status: 401,
				headers: { "www-authenticate": 'Basic realm="celld-sites", charset="UTF-8"', "cache-control": "no-store", ...HEADERS },
			});
		}

		const model = await getModel();
		if (pathname === "/") return html(overviewPage(model));
		if (pathname === "/api/overview.json") {
			return Response.json(model, { headers: { ...HEADERS, "cache-control": "no-store" } });
		}
		const match = pathname.match(/^\/site\/([^/]+)$/);
		if (match) {
			let host: string;
			try {
				host = decodeURIComponent(match[1]!);
			} catch {
				return html(notFoundPage(model, "Bad site name."), 400);
			}
			const site = model.sites.find((s) => s.id === host);
			return site ? html(sitePage(model, site)) : html(notFoundPage(model, `No site ${host}.`), 404);
		}
		return html(notFoundPage(model, `Nothing at ${pathname}.`), 404);
	},
});

console.log(`dashboard listening on :${config.port}`);
