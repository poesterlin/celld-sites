import { accountsApi } from "#lib/server/accounts.ts";

export const DELETE = accountsApi(undefined, (event, user, a) => ({ revoked: a.revokeAll(user.id, user.id, event.locals.session?.hash) }));
