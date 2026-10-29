import { guard, json, readJson, requireSameOrigin, requireUser } from "#lib/server/http.js";

export const GET = guard(async (event) => {
	const c = event.locals.core;
	const me = requireUser(event);
	const mine = c.db.prepare("SELECT * FROM grains WHERE owner_id = ? ORDER BY COALESCE(opened_at, created_at) DESC").all(me.id);
	const shared = c.db
		.prepare(
			"SELECT DISTINCT g.* FROM members m JOIN shares s ON s.id = m.share_id JOIN grains g ON g.id = s.grain_id WHERE m.user_id = ? AND s.revoked_at IS NULL AND g.trashed_at IS NULL AND g.owner_id != ? ORDER BY COALESCE(g.opened_at, g.created_at) DESC",
		)
		.all(me.id, me.id);
	const shareCounts = new Map(
		c.db
			.prepare("SELECT grain_id, COUNT(*) AS n FROM shares WHERE revoked_at IS NULL AND created_by = ? GROUP BY grain_id")
			.all(me.id)
			.map((r) => [r.grain_id, r.n]),
	);
	return json(c, 200, {
		mine: mine.filter((g) => !g.trashed_at).map((g) => c.grainJson(g, c.accessFor(g, { userId: me.id }), { shared: (shareCounts.get(g.id) ?? 0) > 0 })),
		shared: shared.map((g) => c.grainJson(g, c.accessFor(g, { userId: me.id }))),
		trash: mine.filter((g) => g.trashed_at).map((g) => c.grainJson(g, null))
	});
});

export const POST = guard(async (event) => {
	const c = event.locals.core;
	const me = requireUser(event);
	requireSameOrigin(event);
	const body = await readJson(event.request);
	const app = c.q.app.get(String(body.slug ?? ""));
	if (!app) return json(c, 404, { error: "that app is not installed" });
	const title = String(body.title ?? "").trim().slice(0, 80) || `Untitled ${app.name}`;
	if (c.db.prepare("SELECT COUNT(*) AS n FROM grains WHERE owner_id = ?").get(me.id).n >= c.MAX_GRAINS_PER_USER) {
		return json(c, 403, { error: `you can have at most ${c.MAX_GRAINS_PER_USER} grains` });
	}
	const id = c.randomId(12);
	try {
		await c.celld.deployGrain(c.grainHost(id), app.code_version, c.manifestOf(app).egress ?? []);
	} catch (err) {
		await c.celld.deleteSite(c.grainHost(id)).catch(() => {});
		throw err;
	}
	c.db.prepare("INSERT INTO grains (id, slug, title, owner_id, code_version, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(id, app.slug, title, me.id, app.code_version, c.now());
	const grain = c.q.grain.get(id);
	return json(c, 201, { grain: c.grainJson(grain, c.accessFor(grain, { userId: me.id })) });
});
