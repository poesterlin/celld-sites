import { accountsApi, body } from "#lib/server/accounts.ts";

export const DELETE = accountsApi(undefined, async (event, user, a) => {
	const { provider, subject } = await body(event);
	a.unlinkIdentity(user.id, String(provider), String(subject));
});
