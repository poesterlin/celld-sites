import { accountsApi } from "#lib/server/accounts.ts";

export const GET = accountsApi(undefined, (event, user, a) => ({ person: a.person(user.id), sessions: a.sessionsOf(user.id, event.locals.session?.hash), providers: a.loginOptions() }));
