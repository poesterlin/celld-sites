import { admin } from "#lib/server/guard.ts";

export function load({ locals }) {
	const c = admin(locals);
	return { people: c.people(), groups: c.groupsList(), invites: c.invitesList().filter((i) => i.status === "open") };
}
