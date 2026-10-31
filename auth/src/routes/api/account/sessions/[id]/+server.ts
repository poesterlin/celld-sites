import { actor, api } from "#lib/server/http.ts";

export const DELETE = api(undefined, ({ locals, params }, user) => void locals.core.revokeSession(actor(user), params.id, user.id));
