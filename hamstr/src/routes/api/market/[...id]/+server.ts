import { guard, json, requireUser } from "#lib/server/http.ts";

export const GET = guard(async (event) => {
	const c = event.locals.core;
	requireUser(event);
	return json(c, 200, await c.storeJson(`/api/v1/apps/${c.storePath(event.params.id)}`));
});
