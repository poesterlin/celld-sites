export function load({ locals }) {
	const c = locals.core;
	if (!locals.user) return { signedOut: true };
	const me = locals.user;
	const rows = c.db.prepare("SELECT * FROM grains WHERE owner_id = ? ORDER BY COALESCE(opened_at, created_at) DESC").all(me.id);
	const shareCounts = new Map(
		c.db
			.prepare("SELECT grain_id, COUNT(*) AS n FROM shares WHERE revoked_at IS NULL AND created_by = ? GROUP BY grain_id")
			.all(me.id)
			.map((r) => [r.grain_id, r.n]),
	);
	return {
		signedOut: false,
		mine: rows
			.filter((g) => !g.trashed_at)
			.map((g) => c.grainJson(g, c.accessFor(g, { userId: me.id }), { shared: (shareCounts.get(g.id) ?? 0) > 0 }))
	};
}
