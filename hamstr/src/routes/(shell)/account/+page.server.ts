export function load({ locals }) {
	if (!locals.user) return {};
	const a = locals.core.accounts;
	return { person: a.person(locals.user.id), sessions: a.sessionsOf(locals.user.id, locals.session?.hash), options: a.loginOptions() };
}
