import { accountsApi } from "#lib/server/accounts.ts";

export const GET = accountsApi({ admin: true }, (_e, _u, a) => ({ people: a.people() }));
