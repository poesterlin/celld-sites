import { guard, json, requireUser } from "#lib/server/http.ts";

export const GET = guard(async (event) => {
	const c = event.locals.core;
	requireUser(event);
	const params = new URLSearchParams();
	for (const key of ["q", "tag", "limit", "offset"]) {
		const value = event.url.searchParams.get(key);
		if (value) params.set(key, value.slice(0, 100));
	}
	return json(c, 200, await c.storeJson(`/api/v1/apps${params.size ? `?${params}` : ""}`));
});
