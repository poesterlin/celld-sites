import { accountsApi, body } from "#lib/server/accounts.ts";

export const GET = accountsApi({ admin: true }, (_e, _u, a) => ({ invites: a.invitesList() }));
export const POST = accountsApi({ admin: true }, async (event, user, a) => a.createInvite(user.id, await body(event)));
