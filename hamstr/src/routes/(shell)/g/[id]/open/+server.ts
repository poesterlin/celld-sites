import { redirect } from "@sveltejs/kit";
import { guard, html, page } from "#lib/server/http.ts";

/** Open a grain at top level (new tab, or recovering an expired grain session). */
export const GET = guard(async (event) => {
	const c = event.locals.core;
	if (!event.locals.user) {
		const next = `${event.url.pathname}${event.url.search}`;
		throw redirect(303, `/auth/login?next=${encodeURIComponent(next)}`);
	}
	const grain = c.q.grain.get(event.params.id);
	if (!c.accessFor(grain, { userId: event.locals.user.id })) {
		const body = `<h1>No such grain</h1><p><a class="button" href="/">Home</a></p>`;
		return html(c, 404, page("Not found", body));
	}
	const location = c.issueTicket(grain, {
		userId: event.locals.user.id,
		parent: event.locals.session.hash,
		path: event.url.searchParams.get("path") ?? "/"
	});
	return new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });
});
