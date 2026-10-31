import { api } from "#lib/server/http.ts";

export const GET = api({ admin: true }, ({ locals }) => ({ people: locals.core.people() }));
