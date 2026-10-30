// Home is your apps, like a phone's home screen, plus what you opened lately.
export function load({ locals }) {
	const c = locals.core;
	if (!locals.user) return { signedOut: true };
	const me = locals.user;
	const rows = c.db
		.prepare("SELECT * FROM grains WHERE owner_id = ? AND trashed_at IS NULL ORDER BY COALESCE(opened_at, created_at) DESC")
		.all(me.id);
	const counts = new Map();
	for (const g of rows) counts.set(g.slug, (counts.get(g.slug) ?? 0) + 1);
	const apps = c.db.prepare("SELECT * FROM apps ORDER BY name COLLATE NOCASE").all().map((a) => c.appJson(a, { mine: counts.get(a.slug) ?? 0 }));
	const many = new Set(apps.filter((a) => a.instances === "many").map((a) => a.slug));
	return {
		signedOut: false,
		admin: c.isAdmin(me),
		apps,
		// Single-instance apps are their own icon already; recents are the documents.
		recent: rows
			.filter((g) => many.has(g.slug))
			.slice(0, 6)
			.map((g) => c.grainJson(g, c.accessFor(g, { userId: me.id }))),
	};
}
