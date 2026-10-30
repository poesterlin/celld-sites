import { guard, json, requireUser } from "#lib/server/http.js";
import { backupName, saveBackupUpload, sendBackup } from "#lib/server/upload.js";

/** Download a backup of a grain: everything it stores, for any app. Owner only. */
export const GET = guard(async (event) => {
	const c = event.locals.core;
	const me = requireUser(event);
	// A download is a navigation from the shell (or a typed URL), never a
	// request another site makes on the owner's behalf.
	const site = event.request.headers.get("sec-fetch-site");
	if (site !== null && site !== "same-origin" && site !== "none") return json(c, 403, { error: "cross-origin request" });
	const grain = c.q.grain.get(event.params.id);
	if (!grain || grain.trashed_at || grain.owner_id !== me.id) return json(c, 404, { error: "no such grain" });
	if (c.isRestoring(grain.id)) return json(c, 409, { error: "this item is being restored right now" });
	const { file } = await c.backupGrain(grain);
	return sendBackup(c, file, backupName(c, grain.title));
});

/** Replace a grain's data with an uploaded backup of it (or of another item of
 *  the same app). Owner only. */
export const PUT = guard(async (event) => {
	const c = event.locals.core;
	const me = requireUser(event);
	const grain = c.q.grain.get(event.params.id);
	if (!grain || grain.trashed_at || grain.owner_id !== me.id) return json(c, 404, { error: "no such grain" });
	const file = await saveBackupUpload(event);
	try {
		const result = await c.restoreGrain(grain, file);
		return json(c, 200, { ok: true, backup: { title: result.header.title, at: result.header.at, appVersion: result.header.appVersion } });
	} finally {
		c.releaseTemp(file);
	}
});
