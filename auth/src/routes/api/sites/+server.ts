import { api } from "#lib/server/http.ts";

export const GET = api({ admin: true }, async ({ locals }) => ({ sites: await locals.core.sites() }));
