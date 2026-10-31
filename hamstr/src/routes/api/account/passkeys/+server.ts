import { accountsApi, body } from "#lib/server/accounts.ts";

export const POST = accountsApi(undefined, async (event, user, a) => {
	const { key, response, label } = await body(event);
	await a.passkeyRegister(user.id, String(key), response, label);
});
