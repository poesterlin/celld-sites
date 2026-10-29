import { json } from "#lib/server/http.js";

export const GET = ({ locals }) => json(locals.core, 200, { ok: true });
