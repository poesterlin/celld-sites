import { guard, json, requireUser } from "#lib/server/http.js";

export const GET = guard(async (event) => {
	const c = event.locals.core;
	const me = requireUser(event);
	return json(c, 200, {
		user: { id: me.id, name: me.name, email: me.email, admin: c.isAdmin(me) },
		config: { name: c.NAME, grainDomain: c.config.grainDomain, storePublic: c.config.storePublic }
	});
});
