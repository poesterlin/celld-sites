import { guard, json, requireSameOrigin, requireUser } from "#lib/server/http.js";

export const DELETE = guard(async (event) => {
	const c = event.locals.core;
	const me = requireUser(event);
	requireSameOrigin(event);
	if (!c.isAdmin(me)) return json(c, 403, { error: "only an admin can remove apps" });
	const app = c.q.app.get(event.params.slug);
	if (!app) return json(c, 404, { error: "that app is not installed" });
	const n = c.db.prepare("SELECT COUNT(*) AS n FROM grains WHERE slug = ?").get(app.slug).n;
	if (n) return json(c, 409, { error: `${app.name} still has ${n} grain${n === 1 ? "" : "s"} (including the trash); delete them first` });
	c.db.prepare("DELETE FROM apps WHERE slug = ?").run(app.slug);
	return json(c, 200, { ok: true });
});
