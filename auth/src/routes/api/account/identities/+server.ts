import { api, body } from "#lib/server/http.ts";

export const DELETE = api(undefined, async (event, user) => {
	const { provider, subject } = await body(event);
	event.locals.core.unlinkIdentity(user.id, String(provider), String(subject));
});
