import { accountsApi, body } from "#lib/server/accounts.ts";

export const GET = accountsApi({ admin: true }, (_e, _u, a) => ({ groups: a.groupsList() }));
export const POST = accountsApi({ admin: true }, async (event, user, a) => ({ id: a.createGroup(user.id, (await body(event)).name) }));
