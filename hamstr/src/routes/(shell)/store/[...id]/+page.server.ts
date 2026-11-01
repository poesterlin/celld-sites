// One app in the store (/store/<publisher>/<app>): the catalog's details and
// releases, plus whether (and which version) this Hamstr has installed. A bare
// /store/<name> is an installed app, from before namespaces or off the store.
export async function load({ locals, params }) {
	const c = locals.core;
	if (!locals.user) return { signedOut: true };
	const me = locals.user;
	const id = params.id;
	let row = id.includes("/") ? c.q.appByStoreId.get(id) : c.q.app.get(id);
	let detail = null;
	let error = null;
	try {
		detail = await c.storeJson(`/api/v1/apps/${c.storePath(row?.store_id ?? id)}`);
	} catch (err) {
		error = err.status === 404 ? "not-found" : err.message;
	}
	if (!row && detail?.app?.id) row = c.q.appByStoreId.get(detail.app.id);
	const installed = row
		? c.appJson(row, {
				grains: c.db.prepare("SELECT COUNT(*) AS n FROM grains WHERE slug = ?").get(row.slug).n,
				mine: c.db.prepare("SELECT COUNT(*) AS n FROM grains WHERE slug = ? AND owner_id = ? AND trashed_at IS NULL").get(row.slug, me.id).n,
			})
		: null;
	if (!detail && !installed) return { missing: true, error };
	return {
		admin: c.isAdmin(me),
		installed,
		detail,
		error,
		storePublic: c.config.storePublic,
	};
}
