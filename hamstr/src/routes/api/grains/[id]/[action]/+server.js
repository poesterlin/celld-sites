import { guard, json, readJson, requireSameOrigin, requireUser } from "#lib/server/http.js";

export const POST = guard(async (event) => {
	const c = event.locals.core;
	const me = requireUser(event);
	requireSameOrigin(event);
	const grain = c.q.grain.get(event.params.id);
	if (!grain) return json(c, 404, { error: "no such grain" });
	const owner = grain.owner_id === me.id;
	const access = c.accessFor(grain, { userId: me.id });
	const action = event.params.action;

	if (action === "open") {
		if (!access) return json(c, 404, { error: "no such grain" });
		const body = await readJson(event.request);
		return json(c, 200, { url: c.issueTicket(grain, { userId: me.id, parent: event.locals.session.hash, path: body.path }) });
	}
	if (action === "leave") {
		c.db.prepare("DELETE FROM members WHERE user_id = ? AND share_id IN (SELECT id FROM shares WHERE grain_id = ?)").run(me.id, grain.id);
		return json(c, 200, { ok: true });
	}
	if (!owner) return json(c, grain.trashed_at || !access ? 404 : 403, { error: "only the owner can do that" });

	if (action === "trash") {
		c.db.prepare("UPDATE grains SET trashed_at = ? WHERE id = ? AND trashed_at IS NULL").run(c.now(), grain.id);
		c.db.prepare("DELETE FROM grain_sessions WHERE grain_id = ?").run(grain.id);
		return json(c, 200, { ok: true });
	}
	if (action === "restore") {
		c.db.prepare("UPDATE grains SET trashed_at = NULL WHERE id = ?").run(grain.id);
		return json(c, 200, { ok: true });
	}
	return json(c, 404, { error: "no such endpoint" });
});
