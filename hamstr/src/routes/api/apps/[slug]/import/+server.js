import { guard, json, requireUser } from "#lib/server/http.js";
import { saveBackupUpload } from "#lib/server/upload.js";

/** A new item of this app, made from an uploaded backup. */
export const POST = guard(async (event) => {
	const c = event.locals.core;
	const me = requireUser(event);
	const app = c.q.app.get(event.params.slug);
	if (!app) return json(c, 404, { error: "that app is not installed" });
	const file = await saveBackupUpload(event);
	try {
		const { grain } = await c.importBackup(me, app, file);
		return json(c, 201, { grain: c.grainJson(grain, c.accessFor(grain, { userId: me.id })) });
	} finally {
		c.releaseTemp(file);
	}
});
