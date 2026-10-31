import { go } from "#lib/server/accounts.ts";
import { guard } from "#lib/server/http.ts";

/** The celld router sends a visitor here with a signed request for one of its sites. */
export const GET = guard(async (event) => {
	const req = event.url.searchParams.get("req");
	const out = await event.locals.core.accounts.authorize(req, event.locals.session?.token);
	if (out.kind === "login") return go(`/auth/login?req=${encodeURIComponent(req)}`);
	if (out.kind === "redirect") return go(out.url);
	if (out.kind === "denied") return go(`/auth/blocked?kind=denied&host=${encodeURIComponent(out.host)}`);
	return go("/auth/blocked?kind=bad");
});
