import { api, body } from "#lib/server/http.ts";

export const POST = api(undefined, async (event, user) => {
	const { key, response, label } = await body(event);
	await event.locals.core.passkeyRegister(user.id, String(key), response, label);
});
