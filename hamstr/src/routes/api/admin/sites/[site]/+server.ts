import { accountsApi, body } from "#lib/server/accounts.ts";

export const PUT = accountsApi({ admin: true }, async (event, user, a) => {
	const { access, groups, users } = await body(event);
	await a.setRule(user.id, event.params.site, { access, groups: groups ?? [], users: users ?? [] });
});
export const DELETE = accountsApi({ admin: true }, async (event, user, a) => void (await a.clearRule(user.id, event.params.site)));
