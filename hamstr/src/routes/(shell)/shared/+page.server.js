export function load({ locals }) {
	const c = locals.core;
	if (!locals.user) return { signedOut: true };
	const me = locals.user;
	const shared = c.db
		.prepare(
			"SELECT DISTINCT g.* FROM members m JOIN shares s ON s.id = m.share_id JOIN grains g ON g.id = s.grain_id WHERE m.user_id = ? AND s.revoked_at IS NULL AND g.trashed_at IS NULL AND g.owner_id != ? ORDER BY COALESCE(g.opened_at, g.created_at) DESC",
		)
		.all(me.id, me.id);
	return { shared: shared.map((g) => c.grainJson(g, c.accessFor(g, { userId: me.id }))) };
}
