export function load({ locals }) {
	const a = locals.core.accounts;
	const people = new Map(a.people().map((p) => [p.id, p.name]));
	return { activity: a.activity(150).map((x) => ({ ...x, targetName: people.get(x.target) ?? null })) };
}
