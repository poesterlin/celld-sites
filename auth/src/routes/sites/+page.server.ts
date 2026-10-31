import { admin } from "#lib/server/guard.ts";

export async function load({ locals }) {
	const c = admin(locals);
	let sites = [];
	let error = null;
	try {
		sites = await c.sites();
	} catch (err) {
		error = err.message;
	}
	return { sites, error, groups: c.groupsList(), people: c.people().filter((p) => p.status === "active") };
}
