import { guard, json, requireSameOrigin, requireUser } from "#lib/server/http.js";

/** Open a single-instance app: its one grain for this person, made on first use. */
export const POST = guard(async (event) => {
	const c = event.locals.core;
	const me = requireUser(event);
	requireSameOrigin(event);
	const app = c.q.app.get(event.params.slug);
	if (!app) return json(c, 404, { error: "that app is not installed" });
	if ((c.manifestOf(app).instances ?? "many") !== "single") return json(c, 409, { error: `${app.name} can have many; pick or make one` });
	const { grain, created } = await c.openApp(me, app);
	return json(c, created ? 201 : 200, { grain: c.grainJson(grain, c.accessFor(grain, { userId: me.id })), created });
});
