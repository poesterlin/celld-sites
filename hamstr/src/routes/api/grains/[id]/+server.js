import { guard, json, readJson, requireSameOrigin, requireUser } from "#lib/server/http.js";

/** The grain and the caller's standing on it, or `grain: null` for a 404. */
function load(event) {
	const c = event.locals.core;
	const me = requireUser(event);
	const grain = c.q.grain.get(event.params.id);
	if (!grain) return { c, me, grain: null };
	const access = c.accessFor(grain, { userId: me.id });
	const owner = grain.owner_id === me.id;
	if (!access && !(owner && grain.trashed_at)) return { c, me, grain: null, access };
	return { c, me, grain, access, owner };
}

export const GET = guard(async (event) => {
	const { c, grain, access } = load(event);
	if (!grain) return json(c, 404, { error: "no such grain" });
	const app = c.q.app.get(grain.slug);
	return json(c, 200, { grain: c.grainJson(grain, access), app: app ? c.appJson(app) : null });
});

export const PATCH = guard(async (event) => {
	const { c, grain, access, owner } = load(event);
	if (!grain) return json(c, 404, { error: "no such grain" });
	requireSameOrigin(event);
	if (!owner) return json(c, grain.trashed_at || !access ? 404 : 403, { error: "only the owner can do that" });
	const body = await readJson(event.request);
	const title = String(body.title ?? "").trim().slice(0, 80);
	if (!title) return json(c, 400, { error: "a title is required" });
	c.db.prepare("UPDATE grains SET title = ? WHERE id = ?").run(title, grain.id);
	const updated = c.q.grain.get(grain.id);
	return json(c, 200, { grain: c.grainJson(updated, c.accessFor(updated, { userId: event.locals.user.id })) });
});

export const DELETE = guard(async (event) => {
	const { c, grain, access, owner } = load(event);
	if (!grain) return json(c, 404, { error: "no such grain" });
	requireSameOrigin(event);
	if (!owner) return json(c, grain.trashed_at || !access ? 404 : 403, { error: "only the owner can do that" });
	if (!grain.trashed_at) return json(c, 409, { error: "move the grain to the trash first" });
	await c.purgeGrain(grain);
	return json(c, 200, { ok: true });
});
