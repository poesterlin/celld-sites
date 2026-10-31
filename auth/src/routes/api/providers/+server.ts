import { actor, api, body } from "#lib/server/http.ts";

export const GET = api({ admin: true }, ({ locals }) => ({ providers: locals.core.providersList() }));
export const POST = api({ admin: true }, async (event, user) => ({ id: event.locals.core.saveProvider(actor(user), await body(event)) }));
