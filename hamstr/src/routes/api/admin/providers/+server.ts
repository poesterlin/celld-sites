import { accountsApi, body } from "#lib/server/accounts.ts";

export const GET = accountsApi({ admin: true }, (_e, _u, a) => ({ providers: a.providersList() }));
export const POST = accountsApi({ admin: true }, async (event, user, a) => ({ id: a.saveProvider(user.id, await body(event)) }));
