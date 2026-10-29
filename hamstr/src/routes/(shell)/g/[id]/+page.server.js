export function load({ locals, params }) {
	const c = locals.core;
	if (!locals.user) return { signedOut: true };
	const me = locals.user;
	const grain = c.q.grain.get(params.id);
	if (!grain) return { missing: true };
	const access = c.accessFor(grain, { userId: me.id });
	const owner = grain.owner_id === me.id;
	if (!access && !(owner && grain.trashed_at)) return { missing: true };
	const app = c.q.app.get(grain.slug);
	return { grain: c.grainJson(grain, access), app: app ? c.appJson(app) : null };
}
