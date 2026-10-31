import { api } from "#lib/server/http.ts";

export const GET = api(undefined, ({ locals }, user) => ({ id: user.id, name: user.name, email: user.email, role: user.role, pending: user.role === "member" ? 0 : locals.core.pendingCount() }));
