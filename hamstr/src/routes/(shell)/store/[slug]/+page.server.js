// One app in the store: the catalog's details and releases, plus whether (and
// which version) this Hamstr has installed.
export async function load({ locals, params }) {
	const c = locals.core;
	if (!locals.user) return { signedOut: true };
	const me = locals.user;
	const row = c.q.app.get(params.slug);
	const installed = row
		? c.appJson(row, {
				grains: c.db.prepare("SELECT COUNT(*) AS n FROM grains WHERE slug = ?").get(row.slug).n,
				mine: c.db.prepare("SELECT COUNT(*) AS n FROM grains WHERE slug = ? AND owner_id = ? AND trashed_at IS NULL").get(row.slug, me.id).n,
			})
		: null;
	let detail = null;
	let error = null;
	try {
		detail = await c.storeJson(`/api/v1/apps/${encodeURIComponent(params.slug)}`);
	} catch (err) {
		error = err.status === 404 ? "not-found" : err.message;
	}
	if (!detail && !installed) return { missing: true, error };
	return {
		admin: c.isAdmin(me),
		installed,
		detail,
		error,
		storePublic: c.config.storePublic,
	};
}
