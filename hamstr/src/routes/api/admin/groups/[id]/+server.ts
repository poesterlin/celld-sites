import { accountsApi, body } from "#lib/server/accounts.ts";

export const PATCH = accountsApi({ admin: true }, async (event, user, a) => void a.renameGroup(user.id, event.params.id, (await body(event)).name));
export const DELETE = accountsApi({ admin: true }, (event, user, a) => void a.deleteGroup(user.id, event.params.id));
