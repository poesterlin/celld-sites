import { accountsApi } from "#lib/server/accounts.ts";

export const DELETE = accountsApi(undefined, (event, user, a) => void a.revokeSession(user.id, event.params.id, user.id));
