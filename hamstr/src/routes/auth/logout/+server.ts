import { fail, guard, sameOrigin } from "#lib/server/http.ts";

export const POST = guard(async (event) => {
	const c = event.locals.core;
	if (!sameOrigin(event, c)) return fail(c, 403, "cross-origin sign-out");
	const session = event.locals.session;
	if (session) c.db.prepare("DELETE FROM sessions WHERE hash = ?").run(session.hash);
	return new Response(null, {
		status: 303,
		headers: { location: "/", "cache-control": "no-store", "set-cookie": `${c.SHELL_COOKIE}=; ${c.cookieAttrs}; Max-Age=0` }
	});
});
