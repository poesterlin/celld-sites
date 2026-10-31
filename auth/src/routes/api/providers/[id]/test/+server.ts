import { api } from "#lib/server/http.ts";

export const POST = api({ admin: true }, ({ locals, params }) => locals.core.testProvider(params.id));
