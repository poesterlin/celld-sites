import { accountsApi } from "#lib/server/accounts.ts";

export const GET = accountsApi({ admin: true }, async (_e, _u, a) => ({ sites: await a.sites() }));
