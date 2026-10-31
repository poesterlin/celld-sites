import { actor, api, body } from "#lib/server/http.ts";

export const GET = api({ admin: true }, ({ locals }) => ({ groups: locals.core.groupsList() }));
export const POST = api({ admin: true }, async (event, user) => ({ id: event.locals.core.createGroup(actor(user), (await body(event)).name) }));
