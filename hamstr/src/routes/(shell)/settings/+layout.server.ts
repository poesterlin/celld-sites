import { error } from "@sveltejs/kit";

export function load({ locals }) {
	if (!locals.user) return {};
	if (!locals.core.isAdmin(locals.user)) error(403, "Only an admin can change settings.");
	return { pending: locals.core.accounts.pendingCount() };
}
