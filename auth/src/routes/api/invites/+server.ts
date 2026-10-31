import { actor, api, body } from "#lib/server/http.ts";

export const GET = api({ admin: true }, ({ locals }) => ({ invites: locals.core.invitesList() }));
export const POST = api({ admin: true }, async (event, user) => event.locals.core.createInvite(actor(user), await body(event)));
