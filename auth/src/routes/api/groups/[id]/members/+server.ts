import { actor, api, body } from "#lib/server/http.ts";

export const PUT = api({ admin: true }, async (event, user) => void event.locals.core.setMembers(actor(user), event.params.id, (await body(event)).users ?? []));
