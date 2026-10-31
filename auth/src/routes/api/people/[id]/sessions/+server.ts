import { actor, api } from "#lib/server/http.ts";

export const DELETE = api({ admin: true }, ({ locals, params }, user) => ({ revoked: locals.core.revokeAll(actor(user), params.id) }));
