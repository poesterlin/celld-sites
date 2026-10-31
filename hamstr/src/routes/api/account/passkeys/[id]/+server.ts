import { accountsApi } from "#lib/server/accounts.ts";

export const DELETE = accountsApi(undefined, (event, user, a) => void a.removePasskey(user.id, event.params.id));
