import { actor, api } from "#lib/server/http.ts";

export const DELETE = api(undefined, ({ locals }, user) => ({ revoked: locals.core.revokeAll(actor(user), user.id, locals.session) }));
