// Read-only dashboard for celld-sites. No authentication (LAN-only via Traefik),
// so it serves GET/HEAD only and has no route that changes anything.
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

Bun.serve({
	port: config.port,
	async fetch(req) {
		if (req.method !== "GET" && req.method !== "HEAD") {
			return new Response("Read-only", { status: 405, headers: { allow: "GET, HEAD" } });
		}
		const { pathname } = new URL(req.url);
		if (pathname === "/health") return new Response("ok");

		const model = await getModel();
		if (pathname === "/") return html(overviewPage(model));
		if (pathname === "/api/overview.json") {
			return Response.json(model, { headers: { ...HEADERS, "cache-control": "no-store" } });
		}
		const match = pathname.match(/^\/site\/([^/]+)$/);
		if (match) {
			const host = decodeURIComponent(match[1]!);
			const site = model.sites.find((s) => s.host === host);
			return site ? html(sitePage(model, site)) : html(notFoundPage(model, `No site ${host}.`), 404);
		}
		return html(notFoundPage(model, `Nothing at ${pathname}.`), 404);
	},
});

console.log(`dashboard listening on :${config.port}`);
