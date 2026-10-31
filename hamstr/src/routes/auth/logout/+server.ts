import { go } from "#lib/server/accounts.ts";
import { fail, guard, sameOrigin } from "#lib/server/http.ts";

function end(event) {
	const c = event.locals.core;
	c.accounts.endSession(event.locals.session?.token);
	return go("/", [c.sessionCookie("", 0)], 303);
}
/** A celld site's sign-out link ends here (a top-level GET); ending a session is harmless to repeat. */
export const GET = guard(end);
export const POST = guard(async (event) => (sameOrigin(event, event.locals.core) ? end(event) : fail(event.locals.core, 403, "cross-origin sign-out")));
