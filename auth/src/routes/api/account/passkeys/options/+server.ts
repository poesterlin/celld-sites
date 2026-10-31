import { api } from "#lib/server/http.ts";

export const POST = api(undefined, ({ locals }, user) => locals.core.passkeyRegisterOptions(user.id));
