import { admin } from "#lib/server/guard.ts";

export function load({ locals }) {
	const c = admin(locals);
	const people = new Map(c.people().map((p) => [p.id, p.name]));
	return { activity: c.activity(150).map((a) => ({ ...a, targetName: people.get(a.target) ?? null })) };
}
