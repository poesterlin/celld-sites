import { api, json } from "#lib/server/http.ts";

export const POST = api({ open: true }, async ({ locals }) => json(200, await locals.core.passkeyLoginOptions()));
