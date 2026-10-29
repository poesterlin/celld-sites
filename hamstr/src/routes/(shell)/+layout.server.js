import { core } from "#lib/server/instance.js";

export function load({ locals }) {
	const c = locals.core ?? core();
	const user = locals.user;
	return {
		me: user ? { id: user.id, name: user.name, email: user.email, admin: c.isAdmin(user) } : null,
		name: c.NAME
	};
}
