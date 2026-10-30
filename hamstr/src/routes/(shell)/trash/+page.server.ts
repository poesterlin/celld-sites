export function load({ locals }) {
	const c = locals.core;
	if (!locals.user) return { signedOut: true };
	const me = locals.user;
	const mine = c.db.prepare("SELECT * FROM grains WHERE owner_id = ? ORDER BY COALESCE(opened_at, created_at) DESC").all(me.id);
	return { trash: mine.filter((g) => g.trashed_at).map((g) => c.grainJson(g, null)) };
}
