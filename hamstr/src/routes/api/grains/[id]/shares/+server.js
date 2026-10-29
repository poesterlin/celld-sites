import { guard, json, readJson, requireSameOrigin, requireUser } from "#lib/server/http.js";

function ownerGrain(event) {
	const c = event.locals.core;
	const me = requireUser(event);
	const grain = c.q.grain.get(event.params.id);
	if (!grain) return { c, me, grain: null };
	const access = c.accessFor(grain, { userId: me.id });
	if (grain.owner_id !== me.id) return { c, me, grain: null, status: grain.trashed_at || !access ? 404 : 403 };
	return { c, me, grain };
}

export const GET = guard(async (event) => {
	const { c, grain, status } = ownerGrain(event);
	if (!grain) return json(c, status ?? 404, { error: status === 403 ? "only the owner can do that" : "no such grain" });
	const rows = c.db
		.prepare(
			"SELECT s.*, (SELECT COUNT(*) FROM members m WHERE m.share_id = s.id) AS people FROM shares s WHERE s.grain_id = ? AND s.revoked_at IS NULL ORDER BY s.created_at DESC",
		)
		.all(grain.id);
	return json(c, 200, { shares: rows.map((s) => ({ id: s.id, role: s.role, label: s.label, createdAt: s.created_at, people: s.people })) });
});

export const POST = guard(async (event) => {
	const { c, grain, status } = ownerGrain(event);
	if (!grain) return json(c, status ?? 404, { error: status === 403 ? "only the owner can do that" : "no such grain" });
	requireSameOrigin(event);
	if (grain.trashed_at) return json(c, 409, { error: "restore the grain before sharing it" });
	const manifest = c.manifestOf(c.q.app.get(grain.slug));
	const body = await readJson(event.request);
	const roles = manifest.roles ?? [];
	const role = roles.length ? String(body.role ?? c.defaultRole(manifest)) : "member";
	if (roles.length && !roles.some((r) => r.id === role)) return json(c, 400, { error: "that role does not exist in this app" });
	if (c.db.prepare("SELECT COUNT(*) AS n FROM shares WHERE grain_id = ? AND revoked_at IS NULL").get(grain.id).n >= c.MAX_SHARES_PER_GRAIN) {
		return json(c, 403, { error: `at most ${c.MAX_SHARES_PER_GRAIN} active links per grain` });
	}
	const raw = c.token(24);
	const id = c.randomId(12);
	const label = String(body.label ?? "").trim().slice(0, 60);
	c.db
		.prepare("INSERT INTO shares (id, hash, grain_id, role, label, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
		.run(id, c.sha256(raw), grain.id, role, label, event.locals.user.id, c.now());
	// The link is shown once; only its hash is stored.
	return json(c, 201, { share: { id, role, label, createdAt: c.now(), people: 0 }, url: `${c.shellOrigin}/s/${raw}` });
});
