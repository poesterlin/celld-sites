import { guard, json, requireSameOrigin, requireUser } from "#lib/server/http.js";

export const DELETE = guard(async (event) => {
	const c = event.locals.core;
	const me = requireUser(event);
	requireSameOrigin(event);
	const share = c.q.share.get(event.params.id);
	const grain = share && c.q.grain.get(share.grain_id);
	if (!share || !grain || grain.owner_id !== me.id) return json(c, 404, { error: "no such link" });
	c.tx(() => {
		c.db.prepare("UPDATE shares SET revoked_at = ? WHERE id = ?").run(c.now(), share.id);
		c.db.prepare("DELETE FROM grain_sessions WHERE share_id = ?").run(share.id);
		c.db.prepare("DELETE FROM tickets WHERE share_id = ?").run(share.id);
	});
	return json(c, 200, { ok: true });
});
