import { actor, api } from "#lib/server/http.ts";

export const DELETE = api({ admin: true }, ({ locals, params }, user) => void locals.core.revokeInvite(actor(user), params.id));
