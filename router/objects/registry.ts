import { limit } from "../lib/limits.ts";

/** Objects already in the index, so each costs one KV read per router isolate.
 *  Bounded: site code picks object names, so it could otherwise grow forever. */
export const indexed = new Set();
export const MAX_INDEXED = 10_000;

/** Record an object for the dashboard; object names are only hashes in storage. */
export async function indexObject(env, key) {
	if ((await env.CODE.get(`obj:${key}`)) !== null) return;
	const id = env.SITE_OBJECTS.idFromName(key).toString();
	await env.CODE.put(`obj:${key}`, "", { metadata: { id, firstSeen: new Date().toISOString() } });
}

/** Claim a new object against the site's quota. Shared by site code and the
 *  admin seeding endpoint so neither route can create databases past the cap. */
export async function claimObject(env, site, key) {
	if ((await env.CODE.get(`obj:${key}`)) !== null) return;
	const max = limit(env, "SITE_MAX_OBJECTS", 1000, 1000);
	const allowed = await env.SITE_OBJECTS.getByName(`~quota~|${site}`).claim(site, key, max);
	if (!allowed) throw new Error(`object quota reached for ${site} (${max})`);
}
