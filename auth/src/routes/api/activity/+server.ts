import { api } from "#lib/server/http.ts";

export const GET = api({ admin: true }, ({ locals, url }) => ({ activity: locals.core.activity(Number(url.searchParams.get("limit") ?? 100), url.searchParams.has("before") ? Number(url.searchParams.get("before")) : undefined) }));
