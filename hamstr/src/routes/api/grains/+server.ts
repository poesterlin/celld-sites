import { guard, json, readJson, requireSameOrigin, requireUser } from "#lib/server/http.ts";

export const GET = guard(async (event) => {
	const c = event.locals.core;
	const me = requireUser(event);
	const mine = c.db.prepare("SELECT * FROM grains WHERE owner_id = ? ORDER BY COALESCE(opened_at, created_at) DESC").all(me.id);
	return json(c, 200, {
		mine: mine.filter((g) => !g.trashed_at).map((g) => c.grainJson(g, c.accessFor(g, { userId: me.id }))),
		trash: mine.filter((g) => g.trashed_at).map((g) => c.grainJson(g, null))
	});
});

export const POST = guard(async (event) => {
	const c = event.locals.core;
	const me = requireUser(event);
	requireSameOrigin(event);
	const body = await readJson(event.request);
	const app = c.q.app.get(String(body.slug ?? ""));
	if (!app) return json(c, 404, { error: "that app is not installed" });
	const grain = await c.createGrain(me, app, body.title);
	return json(c, 201, { grain: c.grainJson(grain, c.accessFor(grain, { userId: me.id })) });
});
