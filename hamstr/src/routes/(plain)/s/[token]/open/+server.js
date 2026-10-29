import { LOGO, guard, html, page, requireSameOrigin } from "#lib/server/http.js";

/** "Open as guest": a link turns into a one-time ticket for its own grain. */
export const POST = guard(async (event) => {
	const c = event.locals.core;
	requireSameOrigin(event);
	const found = c.shareFromToken(event.params.token);
	if (!found) {
		const body = `<div class="logo-lg">${LOGO}</div><h1>This link doesn't work anymore</h1><p class="dim">It may have been turned off by the person who shared it.</p>`;
		return html(c, 404, page("Link not working", body));
	}
	return new Response(null, {
		status: 303,
		headers: {
			location: c.issueTicket(found.grain, { shareId: found.share.id }),
			"cache-control": "no-store",
			"referrer-policy": "no-referrer"
		}
	});
});
