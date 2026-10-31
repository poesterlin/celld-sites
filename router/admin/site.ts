import { authCache } from "../auth/policy.ts";
import { egressCache } from "../egress/cache.ts";
import { fail, json } from "../lib/http.ts";
import { HOSTNAME, aliasCache } from "../lib/sites.ts";
import { listAll } from "../lib/util.ts";
import { indexed } from "../objects/registry.ts";
import { metas } from "../serve/meta.ts";

/** DELETE /__admin/site?id=S&confirm=S[&aliases=delete] deletes a site: it stops
 *  serving at once, then its Durable Objects' data, deploy history, staging records
 *  and (only with aliases=delete) the aliases pointing at it are deleted. Its
 *  versions stay until the next prune (identical builds share a version). Objects
 *  missing from the index (created before it existed) can't be found by name and
 *  are counted in the dashboard as "not in the index". */
export async function deleteSite(env, url) {
	const id = url.searchParams.get("id") ?? "";
	if (!HOSTNAME.test(id)) return fail(400, "bad site id");
	if (url.searchParams.get("confirm") !== id) return fail(400, "confirm must repeat the site id");
	if ((await env.CODE.get(`alias:${id}`)) !== null) return fail(409, `${id} is an alias, not a site id; DELETE /alias removes it`);
	if ((await env.CODE.get(`site:${id}`)) === null) return fail(404, `no site ${id}`);
	const aliasKeys = [];
	for (const k of await listAll(env.CODE, "alias:")) if ((await env.CODE.get(k.name)) === id) aliasKeys.push(k.name);
	if (aliasKeys.length && url.searchParams.get("aliases") !== "delete") {
		return fail(409, `aliases point at ${id}: ${aliasKeys.map((k) => k.slice(6)).join(", ")} (add aliases=delete)`);
	}
	// Stop serving first, so no new request recreates an object while we delete.
	await env.CODE.delete(`site:${id}`);
	metas.clear();
	for (const k of aliasKeys) {
		await env.CODE.delete(k);
		aliasCache.delete(k.slice(6));
	}
	aliasCache.delete(id);
	const objects = [];
	const errors = [];
	for (const k of await listAll(env.CODE, `obj:${id}|`)) {
		const key = k.name.slice("obj:".length);
		const className = key.split("|")[1];
		try {
			await env.SITE_OBJECTS.getByName(key).destroy(className);
			await env.CODE.delete(k.name);
			indexed.delete(key);
			objects.push(key.slice(id.length + 1));
		} catch (e) {
			errors.push(`${key}: ${String(e?.message ?? e).slice(0, 200)}`);
		}
	}
	let history = 0;
	for (const k of await listAll(env.CODE, `deploy:${id}:`)) {
		await env.CODE.delete(k.name);
		history++;
	}
	for (const k of await listAll(env.CODE, `staged:${id}:`)) await env.CODE.delete(k.name);
	await env.CODE.delete(`egress:${id}`);
	egressCache.delete(id);
	await env.CODE.delete(`auth:${id}`);
	authCache.clear();
	try {
		await env.SITE_OBJECTS.getByName(`~quota~|${id}`).clear();
	} catch (e) {
		errors.push(`quota: ${String(e?.message ?? e).slice(0, 200)}`);
	}
	const result = { id, aliases: aliasKeys.map((k) => k.slice(6)), objects: objects.length, history, errors };
	return errors.length ? json(result, 500) : json(result);
}
