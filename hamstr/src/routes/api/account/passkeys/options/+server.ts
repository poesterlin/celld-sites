import { accountsApi } from "#lib/server/accounts.ts";

export const POST = accountsApi(undefined, (_e, user, a) => a.passkeyRegisterOptions(user.id));
