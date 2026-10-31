import { redirect } from "@sveltejs/kit";
import { SESSION_COOKIE, sameOrigin } from "#lib/server/http.ts";

function end({ locals, cookies }) {
	locals.core.endSession(locals.sessionToken);
	cookies.delete(SESSION_COOKIE, { path: "/" });
	redirect(303, "/login");
}
// The router sends signing out of a site here; ending the session there is harmless to repeat.
export const GET = end;
export const POST = (event) => (sameOrigin(event) ? end(event) : new Response("cross-site request refused", { status: 403 }));
