import { accountsApi } from "#lib/server/accounts.ts";

export const DELETE = accountsApi({ admin: true }, (event, user, a) => void a.revokeInvite(user.id, event.params.id));
