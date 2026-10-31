import { core } from "#lib/server/instance.ts";

export function load({ locals }) {
	const c = locals.core ?? core();
	const user = locals.user;
	return {
		me: user ? { id: user.id, name: user.name, email: user.email, role: user.role, admin: c.isAdmin(user) } : null,
		// People waiting for an admin to let them in.
		pending: user && c.isAdmin(user) ? c.accounts.pendingCount() : 0,
		name: c.NAME
	};
}
