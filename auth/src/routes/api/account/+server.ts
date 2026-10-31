import { api } from "#lib/server/http.ts";

export const GET = api(undefined, ({ locals }, user) => ({
	person: locals.core.person(user.id),
	sessions: locals.core.sessionsOf(user.id, locals.session),
	providers: locals.core.loginOptions(),
}));
