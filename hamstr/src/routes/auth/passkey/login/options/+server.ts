import { accountsApi } from "#lib/server/accounts.ts";

export const POST = accountsApi({ open: true }, (_event, _user, accounts) => accounts.passkeyLoginOptions());
