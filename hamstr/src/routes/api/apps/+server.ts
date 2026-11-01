import { guard, json, readJson, requireSameOrigin, requireUser } from "#lib/server/http.ts";

export const GET = guard(async (event) => {
	const c = event.locals.core;
	requireUser(event);
	const counts = new Map(c.db.prepare("SELECT slug, COUNT(*) AS n FROM grains GROUP BY slug").all().map((r) => [r.slug, r.n]));
	const apps = c.db.prepare("SELECT * FROM apps ORDER BY name COLLATE NOCASE").all();
	return json(c, 200, { apps: apps.map((a) => c.appJson(a, { grains: counts.get(a.slug) ?? 0 })) });
});

export const POST = guard(async (event) => {
	const c = event.locals.core;
	const me = requireUser(event);
	requireSameOrigin(event);
	if (!c.isAdmin(me)) return json(c, 403, { error: "only an admin can install apps" });
	const body = await readJson(event.request);
	// The store's <publisher>/<app>; a bare name only reaches apps from before namespaces.
	const id = String(body.id ?? body.slug ?? "");
	if (!/^(?:[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])\/)?[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])$/.test(id)) return json(c, 400, { error: "bad app id" });
	const version = body.version === undefined ? undefined : String(body.version);
	return json(c, 200, await c.install(id, { version, allowEgress: body.allowEgress === true, user: me }));
});
