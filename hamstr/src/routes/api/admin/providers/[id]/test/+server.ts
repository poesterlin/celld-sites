import { accountsApi } from "#lib/server/accounts.ts";

export const POST = accountsApi({ admin: true }, (event, _u, a) => a.testProvider(event.params.id));
