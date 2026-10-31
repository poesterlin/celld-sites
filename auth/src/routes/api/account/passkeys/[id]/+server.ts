import { api } from "#lib/server/http.ts";

export const DELETE = api(undefined, ({ locals, params }, user) => void locals.core.removePasskey(user.id, params.id));
