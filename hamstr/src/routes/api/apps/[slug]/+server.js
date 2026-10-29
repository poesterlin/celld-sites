import { guard, json, requireSameOrigin, requireUser } from "#lib/server/http.js";

/** An installed app, with what uninstalling it would delete. */
export const GET = guard(async (event) => {
	const c = event.locals.core;
	const me = requireUser(event);
	const app = c.q.app.get(event.params.slug);
	if (!app) return json(c, 404, { error: "that app is not installed" });
	return json(c, 200, { app: c.appJson(app), usage: c.usage(app.slug, me) });
});

/** Uninstall for everyone. `?items=delete` also deletes every item made with it. */
export const DELETE = guard(async (event) => {
	const c = event.locals.core;
	const me = requireUser(event);
	requireSameOrigin(event);
	if (!c.isAdmin(me)) return json(c, 403, { error: "only an admin can uninstall apps" });
	return json(c, 200, { ok: true, ...(await c.uninstall(event.params.slug, { deleteItems: event.url.searchParams.get("items") === "delete" })) });
});
