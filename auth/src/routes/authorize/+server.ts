import { external } from "#lib/server/http.ts";

/** The router sends a browser here with a signed request. */
export async function GET({ url, locals }) {
	const req = url.searchParams.get("req");
	const out = await locals.core.authorize(req, locals.sessionToken);
	if (out.kind === "login") return external(`/login?req=${encodeURIComponent(req)}`);
	if (out.kind === "redirect") return external(out.url);
	if (out.kind === "denied") return external(`/blocked?kind=denied&host=${encodeURIComponent(out.host)}`);
	return external("/blocked?kind=bad");
}
