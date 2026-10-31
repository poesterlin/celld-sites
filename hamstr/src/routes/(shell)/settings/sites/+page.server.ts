export async function load({ locals }) {
	const a = locals.core.accounts;
	let sites = [];
	let error = null;
	try {
		sites = await a.sites();
	} catch (err) {
		error = err.message;
	}
	return { sites, error, groups: a.groupsList(), people: a.people().filter((p) => p.status === "active") };
}
