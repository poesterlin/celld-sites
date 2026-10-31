export function load({ locals }) {
	const a = locals.core.accounts;
	return { groups: a.groupsList(), people: a.people().filter((p) => p.status === "active") };
}
