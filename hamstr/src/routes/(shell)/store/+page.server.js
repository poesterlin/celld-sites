export async function load({ locals }) {
	const c = locals.core;
	if (!locals.user) return { signedOut: true };
	const counts = new Map(c.db.prepare("SELECT slug, COUNT(*) AS n FROM grains GROUP BY slug").all().map((r) => [r.slug, r.n]));
	const apps = c.db.prepare("SELECT * FROM apps ORDER BY name COLLATE NOCASE").all();
	let market;
	try {
		market = await c.storeJson("/api/v1/apps?limit=60");
	} catch (err) {
		market = { error: err.message };
	}
	return {
		admin: c.isAdmin(locals.user),
		apps: apps.map((a) => c.appJson(a, { grains: counts.get(a.slug) ?? 0 })),
		market
	};
}
