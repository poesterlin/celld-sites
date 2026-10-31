import { accountsApi } from "#lib/server/accounts.ts";

export const GET = accountsApi({ admin: true }, ({ url }, _u, a) => ({ activity: a.activity(Number(url.searchParams.get("limit") ?? 100), url.searchParams.has("before") ? Number(url.searchParams.get("before")) : undefined) }));
