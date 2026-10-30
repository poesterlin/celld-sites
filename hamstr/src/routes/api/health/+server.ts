import { json } from "#lib/server/http.ts";

export const GET = ({ locals }) => json(locals.core, 200, { ok: true });
