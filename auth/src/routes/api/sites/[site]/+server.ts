import { actor, api, body } from "#lib/server/http.ts";

export const PUT = api({ admin: true }, async (event, user) => {
	const { access, groups, users } = await body(event);
	await event.locals.core.setRule(actor(user), event.params.site, { access, groups: groups ?? [], users: users ?? [] });
});
export const DELETE = api({ admin: true }, async ({ locals, params }, user) => void (await locals.core.clearRule(actor(user), params.site)));
