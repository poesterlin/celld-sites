import { accountsApi } from "#lib/server/accounts.ts";

export const DELETE = accountsApi({ admin: true }, (event, user, a) => ({ revoked: a.revokeAll(user.id, event.params.id) }));
