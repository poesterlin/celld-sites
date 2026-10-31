import { accountsApi, body } from "#lib/server/accounts.ts";

export const PUT = accountsApi({ admin: true }, async (event, user, a) => {
	a.setPersonGroups(user.id, event.params.id, (await body(event)).groups ?? []);
	return a.person(event.params.id);
});
