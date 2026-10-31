export function load({ locals }) {
	const c = locals.core;
	return {
		person: c.person(locals.user.id),
		sessions: c.sessionsOf(locals.user.id, locals.session),
		options: c.loginOptions(),
	};
}
