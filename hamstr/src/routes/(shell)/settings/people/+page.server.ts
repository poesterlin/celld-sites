export function load({ locals }) {
	const a = locals.core.accounts;
	return { people: a.people(), groups: a.groupsList(), invites: a.invitesList().filter((i) => i.status === "open") };
}
