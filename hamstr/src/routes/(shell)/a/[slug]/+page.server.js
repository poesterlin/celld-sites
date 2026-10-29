// One app: what you made with it, and its trash.
export function load({ locals, params }) {
	const c = locals.core;
	if (!locals.user) return { signedOut: true };
	const me = locals.user;
	const app = c.q.app.get(params.slug);
	if (!app) return { missing: true };
	const rows = c.db.prepare("SELECT * FROM grains WHERE owner_id = ? AND slug = ? ORDER BY COALESCE(opened_at, created_at) DESC").all(me.id, app.slug);
	const mine = (g) => c.grainJson(g, c.accessFor(g, { userId: me.id }));
	return {
		admin: c.isAdmin(me),
		app: c.appJson(app),
		mine: rows.filter((g) => !g.trashed_at).map(mine),
		trash: rows.filter((g) => g.trashed_at).map((g) => c.grainJson(g, null)),
	};
}
