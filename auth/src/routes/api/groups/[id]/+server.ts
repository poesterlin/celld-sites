import { actor, api, body } from "#lib/server/http.ts";

export const PATCH = api({ admin: true }, async (event, user) => void event.locals.core.renameGroup(actor(user), event.params.id, (await body(event)).name));
export const DELETE = api({ admin: true }, ({ locals, params }, user) => void locals.core.deleteGroup(actor(user), params.id));
