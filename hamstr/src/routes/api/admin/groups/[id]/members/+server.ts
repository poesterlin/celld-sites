import { accountsApi, body } from "#lib/server/accounts.ts";

export const PUT = accountsApi({ admin: true }, async (event, user, a) => void a.setMembers(user.id, event.params.id, (await body(event)).users ?? []));
