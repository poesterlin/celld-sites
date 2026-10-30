import { guard, json, requireUser } from "#lib/server/http.ts";
import { grainExport } from "../../../../../../lib/proxy.ts";

/** Download a grain's data, in whatever format its app exports. Owner only. */
export const GET = guard(async (event) => {
	const c = event.locals.core;
	const me = requireUser(event);
	// A download is a navigation from the shell (or a typed URL), never a
	// request another site makes on the owner's behalf.
	const site = event.request.headers.get("sec-fetch-site");
	if (site !== null && site !== "same-origin" && site !== "none") return json(c, 403, { error: "cross-origin request" });
	const grain = c.q.grain.get(event.params.id);
	if (!grain || grain.trashed_at || grain.owner_id !== me.id) return json(c, 404, { error: "no such grain" });
	const app = c.q.app.get(grain.slug);
	const path = app && c.manifestOf(app).export;
	if (!path) return json(c, 404, { error: `${app?.name ?? "This app"} can't export its data yet` });
	return grainExport(c, grain, me, path);
});
