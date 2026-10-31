import { admin } from "#lib/server/guard.ts";

export function load({ locals }) {
	const c = admin(locals);
	return { groups: c.groupsList(), people: c.people().filter((p) => p.status === "active") };
}
